/**
 * Lightweight multi-turn query rewrite for retrieval.
 * Uses the same OpenAI-compatible endpoint as the chat agent.
 */

import { Logger } from '@nestjs/common';
import { getRagRetrievalConfig } from './rag-config';

const logger = new Logger('QueryRewrite');

export type RewriteResult = {
  /** Query to use for retrieval (and to hint the agent). */
  rewriteQuery: string;
  /** Original user text when rewrite is skipped or fails. */
  original: string;
  /** True when an LLM rewrite was applied. */
  rewritten: boolean;
};

/**
 * Rewrite the latest user question into a self-contained search query
 * using recent conversation turns. On failure or when disabled, returns original.
 */
export async function rewriteQueryForRetrieval(
  userMessage: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<RewriteResult> {
  const original = userMessage.trim();
  const cfg = getRagRetrievalConfig();
  if (!cfg.queryRewriteEnabled || !original) {
    return { rewriteQuery: original, original, rewritten: false };
  }

  // Single-turn with no pronouns still benefits little; skip LLM when history empty
  // and message is already reasonably long / specific.
  if (!history.length && original.length >= 12 && !needsRewriteHeuristics(original)) {
    return { rewriteQuery: original, original, rewritten: false };
  }

  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
    /\/$/,
    '',
  );
  const model = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();

  const recent = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`)
    .join('\n');

  const system = `You rewrite user questions into self-contained search queries for a knowledge-base retrieval system.
Rules:
- Output ONLY the rewritten query text, no quotes, no JSON, no explanation.
- Preserve named entities, product names, error codes, and technical terms exactly.
- Resolve pronouns and references using the conversation history (e.g. "it", "that", "上面").
- Keep the same language as the user question.
- Do NOT add meta instructions like "search the knowledge base".
- If the question is already self-contained, return it unchanged (or lightly cleaned).`;

  const user = recent
    ? `Conversation history:\n${recent}\n\nLatest user question:\n${original}\n\nRewritten search query:`
    : `Latest user question:\n${original}\n\nRewritten search query:`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 128,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(`rewrite HTTP ${res.status}: ${text.slice(0, 160)}`);
      return { rewriteQuery: original, original, rewritten: false };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = (json.choices?.[0]?.message?.content || '').trim();
    const cleaned = cleanRewriteOutput(raw);
    if (!cleaned || cleaned.length < 2) {
      return { rewriteQuery: original, original, rewritten: false };
    }
    if (cleaned === original) {
      return { rewriteQuery: original, original, rewritten: false };
    }
    logger.debug(`rewrite: "${original.slice(0, 60)}" → "${cleaned.slice(0, 60)}"`);
    return { rewriteQuery: cleaned, original, rewritten: true };
  } catch (err) {
    logger.warn(`rewrite failed: ${err instanceof Error ? err.message : String(err)}`);
    return { rewriteQuery: original, original, rewritten: false };
  }
}

function needsRewriteHeuristics(text: string): boolean {
  // Short follow-ups / deictic references benefit from rewrite even without history
  // (history path always rewrites when enabled).
  if (text.length < 24) return true;
  return /(\b(it|this|that|they|those|上面|這個|这个|那個|那个|上述|前述)\b)/i.test(text);
}

function cleanRewriteOutput(raw: string): string {
  let s = raw.trim();
  // Strip common wrappers
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith('「') && s.endsWith('」')) ||
    (s.startsWith('『') && s.endsWith('』'))
  ) {
    s = s.slice(1, -1).trim();
  }
  // First line only
  s = s.split('\n')[0]?.trim() || s;
  // Drop accidental prefixes
  s = s.replace(/^(rewritten( search)? query|search query|查询|改写)[:：]\s*/i, '');
  return s.trim();
}
