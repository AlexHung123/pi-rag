import { describe, expect, it, vi } from 'vitest';
import {
  applyMidRunContextGuard,
  buildSummaryUserMessage,
  capOversizedToolResults,
  compactMessagesIfNeeded,
  estimateMessageTokens,
  estimateMessagesTokens,
  findFirstKeptIndex,
  getAgentCompactionSettings,
  getMaxToolResultChars,
  resolveCompactionThreshold,
  shouldCompact,
  type CompactableMessage,
} from '../src/agent/agent-compaction';

function user(text: string): CompactableMessage {
  return { role: 'user', content: text, timestamp: 1 };
}

function assistant(text: string): CompactableMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 1,
  };
}

function toolResult(text: string, toolName = 'retrieve_chunks'): CompactableMessage {
  return {
    role: 'toolResult',
    toolName,
    content: [{ type: 'text', text }],
    timestamp: 1,
  };
}

/** ~N tokens via chars/4 heuristic (padding with 'x'). */
function padTokens(approxTokens: number): string {
  return 'x'.repeat(Math.max(1, approxTokens * 4));
}

describe('getAgentCompactionSettings', () => {
  it('defaults enabled with pi-like reserve/keep', () => {
    const s = getAgentCompactionSettings({});
    expect(s.enabled).toBe(true);
    expect(s.reserveTokens).toBe(16_384);
    expect(s.keepRecentTokens).toBe(20_000);
    expect(s.thresholdTokens).toBeUndefined();
  });

  it('can disable via env', () => {
    expect(getAgentCompactionSettings({ AGENT_COMPACTION_ENABLED: 'false' }).enabled).toBe(
      false,
    );
  });
});

describe('shouldCompact / threshold', () => {
  it('defaults to min(window-reserve, 150k) when threshold unset', () => {
    const thr = resolveCompactionThreshold({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      contextWindow: 256_000,
    });
    // Practical cap so RAG does not wait until ~240k tokens.
    expect(thr).toBe(150_000);
  });

  it('uses window-reserve when that is below the practical cap', () => {
    const thr = resolveCompactionThreshold({
      enabled: true,
      reserveTokens: 2_000,
      keepRecentTokens: 1_000,
      contextWindow: 50_000,
    });
    expect(thr).toBe(48_000);
  });

  it('honors explicit threshold', () => {
    const thr = resolveCompactionThreshold({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      thresholdTokens: 50_000,
      contextWindow: 256_000,
    });
    expect(thr).toBe(50_000);
  });

  it('does not compact when disabled or under threshold', () => {
    const cfg = {
      enabled: true,
      reserveTokens: 1000,
      keepRecentTokens: 500,
      contextWindow: 10_000,
    };
    expect(shouldCompact(500, cfg)).toBe(false);
    expect(shouldCompact(9500, cfg)).toBe(true);
    expect(shouldCompact(9500, { ...cfg, enabled: false })).toBe(false);
  });
});

describe('estimateMessageTokens', () => {
  it('estimates text roughly as chars/4', () => {
    const m = user('abcd'.repeat(100)); // 400 chars → 100 tokens
    expect(estimateMessageTokens(m)).toBe(100);
  });

  it('counts tool call arguments on assistant', () => {
    const m: CompactableMessage = {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          name: 'retrieve_chunks',
          arguments: { question: 'hello world' },
        },
      ],
    };
    expect(estimateMessageTokens(m)).toBeGreaterThan(1);
  });
});

describe('findFirstKeptIndex', () => {
  it('returns 0 when all messages fit keep budget', () => {
    const msgs = [user('hi'), assistant('yo')];
    expect(findFirstKeptIndex(msgs, 10_000)).toBe(0);
  });

  it('prefers a user turn boundary and keeps tool batches intact', () => {
    const msgs: CompactableMessage[] = [
      user(padTokens(5000)),
      assistant(padTokens(5000)),
      user(padTokens(100)),
      assistant('calling tools'),
      toolResult(padTokens(3000)),
      toolResult(padTokens(3000)),
    ];
    // Keep budget small enough to force a cut into the first half.
    const cut = findFirstKeptIndex(msgs, 500);
    // Should not land mid-toolResults without assistant; user at index 2 is ideal.
    expect(cut).toBeLessThanOrEqual(2);
    expect(isUserOrSafe(msgs, cut)).toBe(true);
    // Tail from cut must include both tool results if cut is at user 2.
    if (cut === 2) {
      expect(msgs.slice(cut).some((m) => m.role === 'toolResult')).toBe(true);
    }
  });
});

function isUserOrSafe(msgs: CompactableMessage[], cut: number): boolean {
  if (cut === 0) return true;
  if (msgs[cut].role === 'user') return true;
  // Allowed: assistant start of a kept turn
  if (msgs[cut].role === 'assistant') return true;
  return false;
}

describe('compactMessagesIfNeeded', () => {
  it('no-ops under threshold', async () => {
    const messages = [user('a'), assistant('b')];
    const summarize = vi.fn(async () => 'SUMMARY');
    const result = await compactMessagesIfNeeded({
      messages,
      contextWindow: 100_000,
      settings: {
        enabled: true,
        reserveTokens: 1_000,
        keepRecentTokens: 500,
        thresholdTokens: 50_000,
      },
      summarize,
    });
    expect(result.compacted).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
    expect(result.messages).toEqual(messages);
  });

  it('summarizes prefix and keeps recent tail', async () => {
    const oldUser = user(padTokens(8_000));
    const oldAsst = assistant(padTokens(8_000));
    const recentUser = user('latest question');
    const recentAsst = assistant('latest answer');
    const messages = [oldUser, oldAsst, recentUser, recentAsst];

    const summarize = vi.fn(async (toSum: CompactableMessage[]) => {
      expect(toSum.length).toBeGreaterThan(0);
      return '## User goals\n- test';
    });

    const result = await compactMessagesIfNeeded({
      messages,
      contextWindow: 256_000,
      settings: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 200, // force small recent window
        thresholdTokens: 100, // force compact
      },
      summarize,
    });

    expect(result.compacted).toBe(true);
    expect(result.hardDrop).toBe(false);
    expect(summarize).toHaveBeenCalledOnce();
    expect(result.messages[0].role).toBe('user');
    expect(String(result.messages[0].content)).toContain('## User goals');
    expect(result.messages[0]._compaction).toBe(true);
    // Latest exchange retained
    expect(
      result.messages.some(
        (m) => m.role === 'user' && String(m.content).includes('latest question'),
      ),
    ).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it('hard-drops when summarize returns null', async () => {
    const messages = [
      user(padTokens(5_000)),
      assistant(padTokens(5_000)),
      user('keep me'),
      assistant('keep me too'),
    ];
    const result = await compactMessagesIfNeeded({
      messages,
      contextWindow: 10_000,
      settings: {
        enabled: true,
        reserveTokens: 100,
        keepRecentTokens: 50,
        thresholdTokens: 100,
      },
      summarize: async () => null,
    });
    expect(result.compacted).toBe(true);
    expect(result.hardDrop).toBe(true);
    expect(result.messages.every((m) => !m._compaction)).toBe(true);
    expect(
      result.messages.some((m) => String(m.content || '').includes('keep me')),
    ).toBe(true);
  });
});

describe('buildSummaryUserMessage', () => {
  it('wraps summary for the model', () => {
    const m = buildSummaryUserMessage('hello', 999);
    expect(m.role).toBe('user');
    expect(String(m.content)).toContain('<summary>');
    expect(String(m.content)).toContain('hello');
    expect(m.tokensBefore).toBe(999);
  });
});

describe('estimateMessagesTokens', () => {
  it('sums message estimates', () => {
    const msgs = [user(padTokens(10)), assistant(padTokens(20))];
    expect(estimateMessagesTokens(msgs)).toBe(
      estimateMessageTokens(msgs[0]) + estimateMessageTokens(msgs[1]),
    );
  });
});

describe('capOversizedToolResults', () => {
  it('no-ops when under maxChars', () => {
    const msgs = [user('hi'), toolResult('small')];
    const { messages, capped } = capOversizedToolResults(msgs, 1000);
    expect(capped).toBe(false);
    expect(messages).toBe(msgs);
  });

  it('clips toolResult bodies over maxChars', () => {
    const big = 'HEAD' + 'z'.repeat(5000) + 'TAIL';
    const msgs = [user('q'), assistant('call'), toolResult(big)];
    const { messages, capped } = capOversizedToolResults(msgs, 200);
    expect(capped).toBe(true);
    expect(messages).not.toBe(msgs);
    const text = String(
      Array.isArray(messages[2].content)
        ? (messages[2].content as Array<{ text?: string }>)[0]?.text
        : messages[2].content,
    );
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toContain('truncated');
    expect(text.startsWith('HEAD')).toBe(true);
    expect(text.endsWith('TAIL')).toBe(true);
  });
});

describe('getMaxToolResultChars', () => {
  it('defaults to 120000 when unset', () => {
    expect(getMaxToolResultChars({})).toBe(120_000);
  });

  it('prefers AGENT_MAX_TOOL_RESULT_CHARS over RAG_EVIDENCE_MAX_CHARS', () => {
    expect(
      getMaxToolResultChars({
        AGENT_MAX_TOOL_RESULT_CHARS: '50000',
        RAG_EVIDENCE_MAX_CHARS: '90000',
      }),
    ).toBe(50_000);
  });
});

describe('applyMidRunContextGuard', () => {
  it('caps tool results even when under compaction threshold', async () => {
    const big = 'x'.repeat(10_000);
    const messages = [user('q'), assistant('t'), toolResult(big)];
    const summarize = vi.fn(async () => 'SUMMARY');
    const result = await applyMidRunContextGuard({
      messages,
      contextWindow: 256_000,
      settings: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
        thresholdTokens: 1_000_000, // never compact
      },
      maxToolResultChars: 500,
      summarize,
    });
    expect(result.toolResultsCapped).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.changed).toBe(true);
    expect(summarize).not.toHaveBeenCalled();
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it('compacts when over threshold after cap', async () => {
    const messages = [
      user(padTokens(8_000)),
      assistant(padTokens(8_000)),
      user('latest'),
      assistant('answer'),
    ];
    const result = await applyMidRunContextGuard({
      messages,
      contextWindow: 256_000,
      settings: {
        enabled: true,
        reserveTokens: 1_000,
        keepRecentTokens: 200,
        thresholdTokens: 100,
      },
      maxToolResultChars: 50_000,
      summarize: async () => '## User goals\n- mid-run',
    });
    expect(result.changed).toBe(true);
    expect(result.compacted).toBe(true);
    expect(String(result.messages[0].content)).toContain('mid-run');
  });
});
