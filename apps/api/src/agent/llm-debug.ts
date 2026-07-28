/**
 * Capture exact LLM request payloads + gateway responses for debugging 500s.
 * Writes under apps/api/data/llm-debug/ (last-request.json, last-error.json, history).
 *
 * Gated by LLM_DEBUG=true (or 1). Default off so chat content is not dumped to disk.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';

const logger = new Logger('LlmDebug');

export type LlmCallSnapshot = {
  at: string;
  conversationId?: string;
  baseUrl: string;
  modelId: string;
  /** Full OpenAI chat.completions body (messages, tools, stream, …) */
  payload: unknown;
  response?: {
    status: number;
    headers: Record<string, string>;
  };
  error?: {
    message: string;
    name?: string;
  };
  summary: {
    messageCount: number;
    toolCount: number;
    stream?: boolean;
    maxTokens?: number;
    roles: string[];
  };
};

export function isLlmDebugEnabled(): boolean {
  const v = (process.env.LLM_DEBUG || '').toLowerCase();
  return v === 'true' || v === '1';
}

function debugDir(): string {
  // Nest cwd is typically apps/api when using npm run dev:api
  const dir = join(process.cwd(), 'data', 'llm-debug');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function summarizePayload(payload: unknown): LlmCallSnapshot['summary'] {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<
    string,
    unknown
  >;
  const messages = Array.isArray(p.messages) ? p.messages : [];
  const tools = Array.isArray(p.tools) ? p.tools : [];
  const roles = messages.map((m) =>
    m && typeof m === 'object'
      ? String((m as { role?: string }).role || '?')
      : '?',
  );
  return {
    messageCount: messages.length,
    toolCount: tools.length,
    stream: typeof p.stream === 'boolean' ? p.stream : undefined,
    maxTokens:
      typeof p.max_tokens === 'number'
        ? p.max_tokens
        : typeof p.max_completion_tokens === 'number'
          ? p.max_completion_tokens
          : undefined,
    roles,
  };
}

/** Keep at most N timestamped error dumps. */
function pruneHistory(dir: string, keep = 20): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('error-') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const f of files.slice(keep)) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

/** In-flight call keyed by a simple token (conversationId + time). */
const pending = new Map<string, LlmCallSnapshot>();

function callKey(conversationId?: string): string {
  return `${conversationId || 'unknown'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function compactErrorMessage(
  message: string,
  baseUrl: string,
  modelId: string,
): string {
  if (/nginx|Internal Server Error|<html/i.test(message)) {
    return (
      `LLM gateway error (HTTP 500 from ${baseUrl}, model ${modelId}). ` +
      (isLlmDebugEnabled()
        ? `See API log and apps/api/data/llm-debug/last-error.json for the exact request payload.`
        : `Set LLM_DEBUG=true on the API to dump the request payload for diagnosis.`)
    );
  }
  return message;
}

/**
 * Build pi-agent / pi-ai hooks that dump the exact chat/completions payload.
 * No-ops for onPayload/onResponse when LLM_DEBUG is not enabled.
 */
export function createLlmDebugHooks(opts: {
  conversationId?: string;
  baseUrl: string;
  modelId: string;
}): {
  onPayload: (payload: unknown) => undefined;
  onResponse: (response: {
    status: number;
    headers: Record<string, string>;
  }) => void;
  /** Call from agent.prompt catch / error paths */
  recordError: (err: unknown) => string;
} {
  if (!isLlmDebugEnabled()) {
    return {
      onPayload: () => undefined,
      onResponse: () => {},
      recordError: (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return compactErrorMessage(message, opts.baseUrl, opts.modelId);
      },
    };
  }

  let activeKey: string | null = null;

  const onPayload = (payload: unknown): undefined => {
    const key = callKey(opts.conversationId);
    activeKey = key;
    const snapshot: LlmCallSnapshot = {
      at: new Date().toISOString(),
      conversationId: opts.conversationId,
      baseUrl: opts.baseUrl,
      modelId: opts.modelId,
      payload,
      summary: summarizePayload(payload),
    };
    pending.set(key, snapshot);

    const dir = debugDir();
    writeJson(join(dir, 'last-request.json'), snapshot);

    logger.log(
      `LLM request → ${opts.baseUrl} model=${opts.modelId} ` +
        `messages=${snapshot.summary.messageCount} tools=${snapshot.summary.toolCount} ` +
        `stream=${snapshot.summary.stream} roles=[${snapshot.summary.roles.join(',')}] ` +
        `conv=${opts.conversationId || '-'} → data/llm-debug/last-request.json`,
    );

    // Do not replace payload (pi-ai uses return value only when !== undefined)
    return undefined;
  };

  const onResponse = (response: {
    status: number;
    headers: Record<string, string>;
  }): void => {
    if (!activeKey) return;
    const snap = pending.get(activeKey);
    if (!snap) return;
    snap.response = {
      status: response.status,
      headers: response.headers || {},
    };
    const dir = debugDir();
    writeJson(join(dir, 'last-request.json'), snap);

    if (response.status >= 400) {
      const stamp = snap.at.replace(/[:.]/g, '-');
      writeJson(join(dir, 'last-error.json'), snap);
      writeJson(join(dir, `error-${stamp}.json`), snap);
      pruneHistory(dir);
      logger.error(
        `LLM HTTP ${response.status} from ${opts.baseUrl} (model=${opts.modelId}) ` +
          `— dump: data/llm-debug/last-error.json`,
      );
    } else {
      logger.debug(`LLM HTTP ${response.status} from ${opts.baseUrl}`);
    }
  };

  const recordError = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : undefined;
    const snap =
      (activeKey && pending.get(activeKey)) ||
      ([...pending.values()].pop() as LlmCallSnapshot | undefined);

    const dir = debugDir();
    if (snap) {
      snap.error = { message, name };
      if (!snap.response && /500|Internal Server Error|nginx/i.test(message)) {
        // Body often embeds nginx HTML when gateway dies before onResponse
        snap.response = {
          status: 500,
          headers: { note: 'inferred-from-error-message' },
        };
      }
      writeJson(join(dir, 'last-request.json'), snap);
      writeJson(join(dir, 'last-error.json'), snap);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeJson(join(dir, `error-${stamp}.json`), snap);
      pruneHistory(dir);
      logger.error(
        `LLM call failed: ${message.slice(0, 200).replace(/\s+/g, ' ')} ` +
          `— full request dump: data/llm-debug/last-error.json ` +
          `(messages=${snap.summary.messageCount} tools=${snap.summary.toolCount})`,
      );
    } else {
      const fallback = {
        at: new Date().toISOString(),
        conversationId: opts.conversationId,
        baseUrl: opts.baseUrl,
        modelId: opts.modelId,
        error: { message, name },
        note: 'No onPayload captured (failure before request build)',
      };
      writeJson(join(dir, 'last-error.json'), fallback);
      logger.error(
        `LLM call failed (no payload captured): ${message.slice(0, 200)}`,
      );
    }

    return compactErrorMessage(message, opts.baseUrl, opts.modelId);
  };

  return { onPayload, onResponse, recordError };
}
