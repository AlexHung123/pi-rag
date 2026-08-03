/**
 * Build a pi-ai Model for the configured OpenAI-compatible endpoint.
 * pi-ai packages are ESM-only; load via importEsm from CommonJS Nest.
 */

import { importEsm } from './import-esm';

export type PiModel = {
  id: string;
  name: string;
  api: 'openai-completions';
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
};

export type PiModelBundle = {
  model: PiModel;
  streamSimple: (...args: unknown[]) => unknown;
  getApiKey: () => string | undefined;
};

export function isLlmConfigured(): boolean {
  const baseUrl = (process.env.OPENAI_BASE_URL || '').trim();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  return Boolean(baseUrl || apiKey);
}

/** Selectable chat model: API id (key) + UI display name (value). */
export type ModelOption = {
  id: string;
  name: string;
};

/** Fallback when OPENAI_MODEL is unset/blank. */
export const DEFAULT_MODEL_ID = 'qwen3.6-35b-a3b-mlx';

/** Default chat model id from env (OPENAI_MODEL). */
export function getDefaultModelId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const id = (env.OPENAI_MODEL || DEFAULT_MODEL_ID).trim();
  return id || DEFAULT_MODEL_ID;
}

/**
 * Parse one allowlist entry.
 * Supports:
 *   - `id=Display Name`  (key=value)
 *   - plain `id`         (name defaults to id)
 */
export function parseModelEntry(
  raw: string | undefined | null,
): ModelOption | null {
  const part = (raw || '').trim();
  if (!part) return null;

  const eq = part.indexOf('=');
  if (eq > 0) {
    const id = part.slice(0, eq).trim();
    const name = part.slice(eq + 1).trim();
    if (!id) return null;
    return { id, name: name || id };
  }

  return { id: part, name: part };
}

/**
 * Parse OPENAI_MODELS-style comma list of key=value entries:
 * trim, drop empties, dedupe by id (first wins).
 */
export function parseModelAllowlist(
  raw: string | undefined | null,
): ModelOption[] {
  if (!raw || !String(raw).trim()) return [];
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const part of String(raw).split(',')) {
    const entry = parseModelEntry(part);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

/**
 * Resolved selectable models: OPENAI_MODELS, or [default] if empty.
 * If the list is non-empty and default is missing, default is prepended
 * (name falls back to id).
 */
export function resolveModelAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): ModelOption[] {
  const defaultId = getDefaultModelId(env);
  const listed = parseModelAllowlist(env.OPENAI_MODELS);
  if (!listed.length) return [{ id: defaultId, name: defaultId }];
  if (!listed.some((m) => m.id === defaultId)) {
    return [{ id: defaultId, name: defaultId }, ...listed];
  }
  return listed;
}

/** Id-only allowlist (for validation / quick checks). */
export function resolveModelAllowlistIds(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return resolveModelAllowlist(env).map((m) => m.id);
}

export function isModelAllowed(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const id = (modelId || '').trim();
  if (!id) return false;
  return resolveModelAllowlistIds(env).includes(id);
}

/** Look up display name for an id (falls back to the id). */
export function getModelDisplayName(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const id = (modelId || '').trim();
  if (!id) return getDefaultModelId(env);
  const hit = resolveModelAllowlist(env).find((m) => m.id === id);
  return hit?.name || id;
}

/** Build a pi-ai model object for a specific id (same gateway/compat). */
export function buildPiModel(
  modelId?: string,
  env: NodeJS.ProcessEnv = process.env,
): PiModel {
  const baseUrl = (
    env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  ).replace(/\/$/, '');
  const id = (modelId || '').trim() || getDefaultModelId(env);
  const name = getModelDisplayName(id, env);

  return {
    id,
    name,
    api: 'openai-completions' as const,
    provider: 'local-openai',
    baseUrl,
    reasoning: false,
    input: ['text'] as Array<'text' | 'image'>,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 16384,
    // Local / OpenAI-compatible servers often lack OpenAI-only fields.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens' as const,
    },
  };
}

export async function loadPiModelBundle(
  modelId?: string,
): Promise<PiModelBundle> {
  const piAi = await importEsm<{
    streamSimple: (...args: unknown[]) => unknown;
  }>('@earendil-works/pi-ai');
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  const model = buildPiModel(modelId);

  return {
    model,
    streamSimple: piAi.streamSimple as PiModelBundle['streamSimple'],
    getApiKey: () => apiKey || undefined,
  };
}
