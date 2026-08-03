/**
 * Lightweight multi-turn query rewrite for retrieval.
 * Uses the same OpenAI-compatible endpoint as the chat agent.
 *
 * Only attempts an LLM rewrite when the latest user turn looks like a
 * retrieval follow-up (deictic / short / ambiguous). Skips generation
 * constraints (length, format) and answer-quality complaints.
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

/** Short ambiguous follow-ups benefit from history; longer self-contained ones do not. */
const SHORT_FOLLOWUP_MAX = 24;

const EN_DEICTIC =
  /\b(it|this|that|they|those|these|them|their|its|the above|previous|aforementioned)\b/i;

/** Chinese deixis — no \b (JS word boundaries do not work for CJK). Avoid bare 其/该 (too many false hits). */
const ZH_DEICTIC =
  /上面|上述|前述|以下|之前|刚才|剛才|這個|这个|那個|那个|這些|这些|那些|它|它们|它們|他的|她的|该文档|該文檔|该文件|該文件|其中|这份|這份|那份|这篇|這篇|那篇/;

const SUMMARIZE_RE =
  /总结|總結|摘要|概括|summarize|summary|tl;?dr/i;

/** Length / style / format-only instructions (not document fact queries). */
const LENGTH_OR_STYLE_RE =
  /(\d+\s*(字|字数|字數|words?|chars?|characters?))|(约|大約|大概|左右|大约).{0,6}(\d+)|(写|寫|再|更|稍微)?(详细|詳細|长|長|短|简洁|簡潔)(一点|一點|些|一些)?|(更长|更長|更短|加长|加長)|(用表格|列表形式|bullet|markdown表格)/i;

const COMPLAINT_RE =
  /(没有|沒有|不够|不夠|不足|太短|太长|太長|写错|寫錯|不对|不對|错了|錯了|不是我说|不是我說|你答错|你答錯)|(这|這).{0,8}(总结|總結|回答|答案).{0,12}(没有|沒有|不够|不夠|太短)/i;

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

  if (!shouldAttemptQueryRewrite(original, history)) {
    return { rewriteQuery: original, original, rewritten: false };
  }

  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
    /\/$/,
    '',
  );
  const model = (process.env.OPENAI_MODEL || 'qwen3.6-35b-a3b-mlx').trim();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();

  const recent = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`)
    .join('\n');

  const system = `You rewrite user questions into self-contained search queries for a knowledge-base retrieval system.
Rules:
- Output ONLY the rewritten query text, no quotes, no JSON, no explanation.
- Preserve named entities, product names, error codes, and technical terms exactly.
- Resolve pronouns and references using the conversation history (e.g. "it", "that", "上面", "它").
- Keep the same language as the user question.
- Do NOT add meta instructions like "search the knowledge base".
- Do NOT include length/word-count targets (e.g. 5000字, 3000 words), formatting requests (tables, bullets), tone, or "write longer/shorter" instructions — those are answer constraints, not search terms.
- Do NOT add filler like "详细全文" / "detailed full text" unless the user asked for a document section by that name.
- Focus on topical keywords and entities needed to find the right chunks.
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
    const cleaned = stripNonRetrievalNoise(cleanRewriteOutput(raw));
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

/**
 * Whether an LLM rewrite is worth the cost for this turn.
 * Multi-turn no longer implies always-rewrite.
 */
export function shouldAttemptQueryRewrite(
  userMessage: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): boolean {
  const text = userMessage.trim();
  if (!text) return false;

  // Answer length / format / complaints are not retrieval queries.
  if (isNonRetrievalFollowUp(text)) return false;

  // Whole-doc summarize with a concrete topic → summarize_document path, not rewrite.
  if (isSelfContainedSummarizeRequest(text) && !hasDeicticReference(text)) {
    return false;
  }

  if (hasDeicticReference(text)) return true;

  // Short ambiguous follow-ups only when there is history to resolve against.
  if (text.length < SHORT_FOLLOWUP_MAX) {
    return history.length > 0;
  }

  // Long, non-deictic messages are already self-contained (with or without history).
  return false;
}

export function hasDeicticReference(text: string): boolean {
  if (EN_DEICTIC.test(text)) return true;
  if (ZH_DEICTIC.test(text)) return true;
  return false;
}

/**
 * True when the user is mainly adjusting answer style/length or complaining
 * about the previous answer — not asking a new document fact question.
 */
export function isNonRetrievalFollowUp(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  if (COMPLAINT_RE.test(t)) return true;

  if (!LENGTH_OR_STYLE_RE.test(t)) return false;

  // Length clause + substantial topical content → still may need retrieval; keep rewrite path open.
  const withoutLength = t
    .replace(/\d+\s*(字|字数|字數|words?|chars?|characters?)/gi, ' ')
    .replace(/(约|大約|大概|左右|大约)\s*\d+/gi, ' ')
    .replace(
      /(写|寫|再|更|稍微)?(详细|詳細|长|長|短|简洁|簡潔)(一点|一點|些|一些)?/gi,
      ' ',
    )
    .replace(/(更长|更長|更短|加长|加長|用表格|列表形式|bullet|markdown表格)/gi, ' ')
    .replace(/(需要|请|請|帮我|幫我|左右)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Almost nothing left after stripping style instructions → pure non-retrieval.
  if (withoutLength.length < 8) return true;

  // Still has a summarize verb + topic → not pure follow-up (e.g. "请用5000字总结…要点")
  if (SUMMARIZE_RE.test(withoutLength) && withoutLength.length >= 10) return false;

  // Residual is still a short command-like phrase
  if (withoutLength.length < 16 && !hasDeicticReference(t)) return true;

  return false;
}

/** Summarize/abstract request that already names a document or topic. */
export function isSelfContainedSummarizeRequest(text: string): boolean {
  const t = text.trim();
  if (!SUMMARIZE_RE.test(t)) return false;
  if (hasDeicticReference(t)) return false;

  const topic = t
    .replace(SUMMARIZE_RE, ' ')
    .replace(/(一下|下|请|請|帮我|幫我|给我|給我|关于|關於|for|the|a|an|of|this|document|doc)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Need a concrete topic/document name beyond the summarize verb.
  return topic.length >= 2;
}

/** Defense-in-depth: drop length/format filler the model may still emit. */
export function stripNonRetrievalNoise(text: string): string {
  let s = text.trim();
  s = s.replace(/\d+\s*(字|字数|字數|words?|chars?|characters?)/gi, ' ');
  s = s.replace(/(约|大約|大概|大约)\s*\d+/gi, ' ');
  s = s.replace(/详细全文|詳細全文|detailed\s+full\s*text/gi, ' ');
  s = s.replace(/(用表格|列表形式|bullet\s*points?|markdown表格)/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
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
