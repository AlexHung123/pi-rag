/**
 * Optional LLM polish for chat memory_save only.
 * UI / admin writes stay verbatim. On any failure → original content.
 */

export type MemoryPolishSettings = {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  maxTokens: number;
};

export function getMemoryPolishSettings(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): MemoryPolishSettings {
  const raw = (env.MEMORY_POLISH_ENABLED ?? 'true').trim().toLowerCase();
  const enabled = raw !== 'false' && raw !== '0';
  const model =
    (env.MEMORY_POLISH_MODEL || env.OPENAI_MODEL || '').trim() ||
    'qwen3.6-35b-a3b-mlx';
  const timeoutMs = envPositiveInt(env.MEMORY_POLISH_TIMEOUT_MS, 15_000, 2_000, 120_000);
  const maxTokens = envPositiveInt(env.MEMORY_POLISH_MAX_TOKENS, 256, 32, 1024);
  return { enabled, model, timeoutMs, maxTokens };
}

function envPositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Common words we do not treat as proper nouns (case-insensitive). */
const LATIN_STOPWORDS = new Set([
  'user',
  'users',
  'prefer',
  'prefers',
  'preferred',
  'please',
  'remember',
  'memory',
  'about',
  'with',
  'from',
  'that',
  'this',
  'have',
  'want',
  'like',
  'likes',
  'name',
  'called',
  'should',
  'always',
  'never',
  'table',
  'tables',
  'short',
  'long',
  'answer',
  'answers',
]);

/**
 * Tokens that should survive polish (latin usernames, codes, product ids).
 * Intentionally does NOT lock general Chinese phrases so the model can
 * rephrase 記住… into a clean sentence in the same or other language.
 * Case-sensitive match on the original spelling (alexhong ≠ alekhong).
 */
export function extractProtectedTokens(text: string): string[] {
  const s = text || '';
  const out = new Set<string>();
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_.@-]{2,79}/g)) {
    const t = m[0];
    // Need length >= 4 so "me"/"is"/"for" are not locked; skip stopwords.
    if (t.length < 4) continue;
    if (LATIN_STOPWORDS.has(t.toLowerCase())) continue;
    out.add(t);
  }
  // Explicit codes / ids: mixed alnum with digit or underscore often matter
  for (const m of s.matchAll(/\b[A-Za-z]*\d[A-Za-z0-9_.-]{1,40}\b/g)) {
    out.add(m[0]);
  }
  return [...out];
}

/**
 * Reject polished text that dropped protected tokens from the original.
 */
export function polishedPreservesProtectedTokens(
  original: string,
  polished: string,
): boolean {
  const tokens = extractProtectedTokens(original);
  if (!tokens.length) return true;
  // Case-sensitive for Latin (alexhong ≠ alekhong)
  for (const t of tokens) {
    if (!polished.includes(t)) return false;
  }
  return true;
}

export function normalizePolishedContent(
  original: string,
  polished: string | null | undefined,
): string {
  const src = (original || '').trim();
  if (!src) return '';
  const p = (polished || '').trim();
  if (!p) return src;

  // Strip common wrappers / quotes
  let cleaned = p
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/^(memory|fact|preference)\s*[:：]\s*/i, '')
    .trim();

  // Single line preference
  cleaned = cleaned.split(/\r?\n/)[0]?.trim() || cleaned;
  if (cleaned.length > 500) cleaned = cleaned.slice(0, 500).trim();
  if (!cleaned) return src;

  if (!polishedPreservesProtectedTokens(src, cleaned)) return src;
  return cleaned;
}

export const MEMORY_POLISH_SYSTEM = `You rewrite user memory into ONE short, self-contained factual sentence for long-term storage.

Rules:
- Output ONLY the rewritten sentence, no quotes, no labels, no explanation.
- Keep the same language as the input (Chinese stay Chinese, English stay English).
- Preserve ALL proper nouns, product names, usernames, codes, and numbers EXACTLY (same spelling and characters). Never "correct" or transliterate them.
- Do not invent facts not present in the input.
- Prefer a clear preference/fact form, e.g. "User prefers markdown tables for comparisons."
- Max ~200 characters when possible; never exceed 500.`;

/**
 * Call OpenAI-compatible chat/completions to polish memory content.
 * Returns null on any failure (caller should keep original).
 */
export async function polishMemoryContentWithLlm(args: {
  content: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const original = (args.content || '').trim();
  if (!original) return null;

  const baseUrl = (args.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) return null;

  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  args.signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(
    () => controller.abort(),
    args.timeoutMs ?? 15_000,
  );

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
        max_tokens: args.maxTokens ?? 256,
        messages: [
          { role: 'system', content: MEMORY_POLISH_SYSTEM },
          {
            role: 'user',
            content: `Rewrite this memory:\n\n${original.slice(0, 800)}`,
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
    if (!text) return null;
    const normalized = normalizePolishedContent(original, text);
    // If normalize fell back to original, treat as "no effective polish"
    return normalized === original ? null : normalized;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Apply optional polish; always returns a string safe to store.
 */
export async function maybePolishMemoryContent(
  content: string,
  opts?: {
    enabled?: boolean;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<{ content: string; polished: boolean }> {
  const original = (content || '').trim();
  if (!original) return { content: '', polished: false };

  const settings = getMemoryPolishSettings(opts?.env ?? process.env);
  const enabled = opts?.enabled ?? settings.enabled;
  if (!enabled) return { content: original.slice(0, 500), polished: false };

  const baseUrl = (
    process.env.OPENAI_BASE_URL ||
    'https://api.openai.com/v1'
  ).replace(/\/$/, '');
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();

  const polished = await polishMemoryContentWithLlm({
    content: original,
    baseUrl,
    apiKey: apiKey || undefined,
    model: settings.model,
    maxTokens: settings.maxTokens,
    timeoutMs: settings.timeoutMs,
    signal: opts?.signal,
    fetchImpl: opts?.fetchImpl,
  });

  if (!polished) {
    return { content: original.slice(0, 500), polished: false };
  }
  return { content: polished.slice(0, 500), polished: true };
}
