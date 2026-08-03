/**
 * Lightweight context compaction for bare pi-agent-core Agent.
 * Runs before prompt (not mid-turn): estimate tokens → summarize older
 * messages → replace agent.state.messages with summary + recent tail.
 *
 * Does not use AgentHarness / session tree. Postgres history is unchanged.
 */

export type CompactableMessage = {
  role: string;
  content?: unknown;
  summary?: string;
  tokensBefore?: number;
  timestamp?: number;
  [key: string]: unknown;
};

export type AgentCompactionSettings = {
  /** Master switch (default true). */
  enabled: boolean;
  /**
   * Compact when estimated tokens exceed this.
   * Default: contextWindow - reserveTokens (clamped ≥ keepRecentTokens + 1).
   */
  thresholdTokens?: number;
  /** Tokens reserved near the model window (default 16384). */
  reserveTokens: number;
  /** Approximate recent tail to keep after compact (default 20000). */
  keepRecentTokens: number;
};

export type CompactionConfig = AgentCompactionSettings & {
  contextWindow: number;
};

export function getAgentCompactionSettings(
  env: NodeJS.ProcessEnv = process.env,
): AgentCompactionSettings {
  const enabledRaw = (env.AGENT_COMPACTION_ENABLED ?? 'true').trim().toLowerCase();
  const enabled = !(enabledRaw === '0' || enabledRaw === 'false' || enabledRaw === 'off');

  return {
    enabled,
    thresholdTokens: envPositiveIntOptional(env.AGENT_COMPACTION_THRESHOLD_TOKENS),
    reserveTokens: envPositiveInt(env.AGENT_COMPACTION_RESERVE_TOKENS, 16_384, 1_024, 500_000),
    keepRecentTokens: envPositiveInt(
      env.AGENT_COMPACTION_KEEP_RECENT_TOKENS,
      20_000,
      1_024,
      500_000,
    ),
  };
}

function envPositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function envPositiveIntOptional(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Resolve absolute threshold from settings + model context window.
 *
 * Default (no env override): min(contextWindow - reserveTokens, 150_000)
 * so RAG sessions compact before a 256k window is full, without being too eager.
 * Set AGENT_COMPACTION_THRESHOLD_TOKENS to pin an exact value.
 */
export function resolveCompactionThreshold(cfg: CompactionConfig): number {
  if (cfg.thresholdTokens !== undefined && cfg.thresholdTokens > 0) {
    return cfg.thresholdTokens;
  }
  const fromWindow = Math.max(1, cfg.contextWindow - cfg.reserveTokens);
  const practicalCap = 150_000;
  return Math.max(
    cfg.keepRecentTokens + 1,
    Math.min(fromWindow, practicalCap),
  );
}

export function shouldCompact(
  contextTokens: number,
  cfg: CompactionConfig,
): boolean {
  if (!cfg.enabled) return false;
  return contextTokens > resolveCompactionThreshold(cfg);
}

/**
 * Conservative token estimate (≈ chars/4), aligned with pi-agent-core heuristics.
 */
export function estimateMessageTokens(message: CompactableMessage): number {
  let chars = 0;
  const role = message.role;

  if (role === 'user' || role === 'toolResult' || role === 'tool') {
    chars += textFromContent(message.content).length;
    if (typeof message.toolName === 'string') chars += message.toolName.length;
  } else if (role === 'assistant') {
    chars += textFromContent(message.content).length;
  } else if (role === 'compactionSummary' && typeof message.summary === 'string') {
    chars += message.summary.length + 80;
  } else {
    chars += textFromContent(message.content).length;
    if (typeof message.summary === 'string') chars += message.summary.length;
  }

  return Math.max(1, Math.ceil(chars / 4));
}

export function estimateMessagesTokens(messages: CompactableMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object') {
      try {
        return JSON.stringify(content);
      } catch {
        return String(content);
      }
    }
    return content == null ? '' : String(content);
  }

  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') out += b.text;
    else if (b.type === 'thinking' && typeof b.thinking === 'string') out += b.thinking;
    else if (b.type === 'toolCall') {
      out += String(b.name || '');
      try {
        out += JSON.stringify(b.arguments ?? {});
      } catch {
        /* ignore */
      }
    } else if (typeof b.text === 'string') {
      out += b.text;
    }
  }
  return out;
}

function isUser(m: CompactableMessage): boolean {
  return m.role === 'user';
}

function isAssistant(m: CompactableMessage): boolean {
  return m.role === 'assistant';
}

function isToolResult(m: CompactableMessage): boolean {
  return m.role === 'toolResult' || m.role === 'tool';
}

/**
 * Index of the first message to keep (recent tail).
 *
 * 1. Walk from the end until recent tokens ≥ keepRecentTokens.
 * 2. Snap to a safe turn boundary without pulling the entire old history back in:
 *    - toolResults → include their assistant (+ preceding user of that turn only)
 *    - assistant mid-history → prefer the *next* user (start of a later turn)
 *    - otherwise prefer a user at/after the cross point
 */
export function findFirstKeptIndex(
  messages: CompactableMessage[],
  keepRecentTokens: number,
): number {
  if (messages.length === 0) return 0;

  let acc = 0;
  let crossed = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i]);
    if (acc >= keepRecentTokens) {
      crossed = i;
      break;
    }
  }
  // Entire transcript fits in keep budget → nothing to drop.
  if (crossed < 0) return 0;

  let cut = crossed;

  if (isToolResult(messages[cut])) {
    // Keep tool batch with its assistant message.
    while (cut > 0 && isToolResult(messages[cut])) {
      cut -= 1;
    }
    // Include the user that opened this turn (immediate predecessor only).
    if (cut > 0 && isAssistant(messages[cut]) && isUser(messages[cut - 1])) {
      cut -= 1;
    }
    return cut;
  }

  if (isAssistant(messages[cut])) {
    // Prefer the next user message so we do not re-include a huge older turn
    // just because this assistant was the token-crossing boundary.
    const nextUser = findNextUserIndex(messages, cut + 1);
    if (nextUser >= 0) return nextUser;
    if (cut > 0 && isUser(messages[cut - 1])) return cut - 1;
    return cut;
  }

  if (isUser(messages[cut])) {
    return cut;
  }

  const nextUser = findNextUserIndex(messages, cut);
  return nextUser >= 0 ? nextUser : cut;
}

function findNextUserIndex(
  messages: CompactableMessage[],
  from: number,
): number {
  for (let j = from; j < messages.length; j++) {
    if (isUser(messages[j])) return j;
  }
  return -1;
}

export const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n';
export const COMPACTION_SUMMARY_SUFFIX = '\n</summary>';

/** User message carrying a compaction summary (works with bare Agent convertToLlm). */
export function buildSummaryUserMessage(
  summary: string,
  tokensBefore: number,
  timestamp = Date.now(),
): CompactableMessage {
  const text = `${COMPACTION_SUMMARY_PREFIX}${summary.trim()}${COMPACTION_SUMMARY_SUFFIX}`;
  return {
    role: 'user',
    content: text,
    timestamp,
    // Marker for debugging / tests (ignored by default convertToLlm filter? kept as user so OK)
    _compaction: true,
    tokensBefore,
  };
}

export type CompactResult = {
  messages: CompactableMessage[];
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
  firstKeptIndex: number;
  /** true when we dropped history without an LLM summary */
  hardDrop: boolean;
};

export type SummarizeFn = (
  messagesToSummarize: CompactableMessage[],
  signal?: AbortSignal,
) => Promise<string | null>;

/**
 * If over threshold, summarize messages[0..firstKept) and keep the tail.
 * On summarize failure: hard-drop older messages (still keep recent tail).
 */
export async function compactMessagesIfNeeded(args: {
  messages: CompactableMessage[];
  contextWindow: number;
  settings: AgentCompactionSettings;
  summarize: SummarizeFn;
  signal?: AbortSignal;
}): Promise<CompactResult> {
  const cfg: CompactionConfig = {
    ...args.settings,
    contextWindow: args.contextWindow,
  };
  const tokensBefore = estimateMessagesTokens(args.messages);

  if (!shouldCompact(tokensBefore, cfg)) {
    return {
      messages: args.messages,
      compacted: false,
      tokensBefore,
      tokensAfter: tokensBefore,
      firstKeptIndex: 0,
      hardDrop: false,
    };
  }

  const firstKept = findFirstKeptIndex(args.messages, cfg.keepRecentTokens);
  if (firstKept <= 0) {
    // Over threshold but cannot free space without dropping the recent tail.
    return {
      messages: args.messages,
      compacted: false,
      tokensBefore,
      tokensAfter: tokensBefore,
      firstKeptIndex: 0,
      hardDrop: false,
    };
  }

  const toSummarize = args.messages.slice(0, firstKept);
  const kept = args.messages.slice(firstKept);

  let summary: string | null = null;
  try {
    summary = await args.summarize(toSummarize, args.signal);
  } catch {
    summary = null;
  }

  const next: CompactableMessage[] = [];
  let hardDrop = false;
  if (summary && summary.trim()) {
    next.push(buildSummaryUserMessage(summary, tokensBefore));
  } else {
    hardDrop = true;
  }
  next.push(...kept);

  const tokensAfter = estimateMessagesTokens(next);
  return {
    messages: next,
    compacted: true,
    tokensBefore,
    tokensAfter,
    firstKeptIndex: firstKept,
    hardDrop,
  };
}

/**
 * Build a plain-text transcript for the summarizer LLM.
 */
export function serializeMessagesForSummary(messages: CompactableMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const role = m.role;
    if (role === 'user') {
      parts.push(`User: ${textFromContent(m.content)}`);
    } else if (role === 'assistant') {
      const text = textFromContent(m.content);
      if (text.trim()) parts.push(`Assistant: ${text}`);
      else parts.push('Assistant: (tool call(s))');
    } else if (role === 'toolResult' || role === 'tool') {
      const name = typeof m.toolName === 'string' ? m.toolName : 'tool';
      const body = textFromContent(m.content).slice(0, 2000);
      parts.push(`Tool(${name}): ${body}`);
    } else if (role === 'compactionSummary' && typeof m.summary === 'string') {
      parts.push(`PriorSummary: ${m.summary}`);
    }
  }
  return parts.join('\n\n');
}

export const RAG_COMPACTION_SYSTEM = `You compress conversation history for a RAG Q&A assistant.
Output a structured checkpoint another model will use to continue answering.

Use this EXACT format:

## User goals
- [What the user is trying to learn or decide]

## Knowledge / sources discussed
- [KB names, document names, topics already retrieved]

## Key facts established
- [Important facts, numbers, definitions already confirmed from evidence]

## Open questions
- [What still needs retrieval or clarification]

## Preferences
- [Language, length, format constraints if any]

Rules:
- Be concise. Preserve exact names, IDs, error codes, and document titles.
- Do NOT invent facts not present in the history.
- Do NOT continue the conversation or answer the user — ONLY the summary.
- Prefer Chinese if the conversation is mostly Chinese.`;

/**
 * Call the OpenAI-compatible chat API to summarize dropped history.
 */
export async function summarizeWithChatCompletions(args: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messagesToSummarize: CompactableMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const baseUrl = args.baseUrl.replace(/\/$/, '');
  if (!baseUrl) return null;

  const transcript = serializeMessagesForSummary(args.messagesToSummarize);
  if (!transcript.trim()) return null;

  // Cap prompt size so summarization itself does not blow the window.
  const clipped =
    transcript.length > 120_000
      ? `${transcript.slice(0, 60_000)}\n\n…\n\n${transcript.slice(-60_000)}`
      : transcript;

  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  args.signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: args.model,
        temperature: 0,
        max_tokens: args.maxTokens ?? 2048,
        messages: [
          { role: 'system', content: RAG_COMPACTION_SYSTEM },
          {
            role: 'user',
            content: `<conversation>\n${clipped}\n</conversation>\n\nWrite the structured checkpoint summary now.`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = (json.choices?.[0]?.message?.content || '').trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onAbort);
  }
}
