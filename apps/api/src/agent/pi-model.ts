/**
 * Build a pi-ai Model for the configured OpenAI-compatible endpoint.
 * pi-ai packages are ESM-only; load via importEsm from CommonJS Nest.
 */

import { importEsm } from './import-esm';

export type PiModelBundle = {
  model: {
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
  streamSimple: (...args: unknown[]) => unknown;
  getApiKey: () => string | undefined;
};

export function isLlmConfigured(): boolean {
  const baseUrl = (process.env.OPENAI_BASE_URL || '').trim();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  return Boolean(baseUrl || apiKey);
}

export async function loadPiModelBundle(): Promise<PiModelBundle> {
  const piAi = await importEsm<{
    streamSimple: (...args: unknown[]) => unknown;
  }>('@earendil-works/pi-ai');
  const baseUrl = (
    process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  ).replace(/\/$/, '');
  const modelId = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();

  const model = {
    id: modelId,
    name: modelId,
    api: 'openai-completions' as const,
    provider: 'local-openai',
    baseUrl,
    reasoning: false,
    input: ['text'] as Array<'text' | 'image'>,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    // Local / OpenAI-compatible servers often lack OpenAI-only fields.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens' as const,
    },
  };

  return {
    model,
    streamSimple: piAi.streamSimple as PiModelBundle['streamSimple'],
    getApiKey: () => apiKey || undefined,
  };
}
