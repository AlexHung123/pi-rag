import { describe, expect, it, vi } from 'vitest';
import {
  extractProtectedTokens,
  getMemoryPolishSettings,
  normalizePolishedContent,
  polishedPreservesProtectedTokens,
  maybePolishMemoryContent,
} from '../src/memory/memory-polish';

describe('getMemoryPolishSettings', () => {
  it('defaults enabled', () => {
    expect(getMemoryPolishSettings({}).enabled).toBe(true);
  });

  it('can disable', () => {
    expect(
      getMemoryPolishSettings({ MEMORY_POLISH_ENABLED: 'false' }).enabled,
    ).toBe(false);
  });
});

describe('protected tokens', () => {
  it('extracts latin proper-ish tokens, skips stopwords', () => {
    const tokens = extractProtectedTokens('User alexhong prefers 繁體中文 tables');
    expect(tokens).toContain('alexhong');
    expect(tokens).not.toContain('User');
    // Chinese phrases are not locked (allow rephrase)
    expect(tokens.every((t) => !/[\u4e00-\u9fff]/.test(t))).toBe(true);
  });

  it('rejects polish that drops name', () => {
    expect(
      polishedPreservesProtectedTokens(
        'Remember name alexhong',
        'Remember name alekhong',
      ),
    ).toBe(false);
  });

  it('accepts polish that keeps name', () => {
    expect(
      polishedPreservesProtectedTokens(
        '記住 alexhong 喜歡短回答',
        'User alexhong prefers short answers',
      ),
    ).toBe(true);
  });
});

describe('normalizePolishedContent', () => {
  it('falls back when empty polish', () => {
    expect(normalizePolishedContent('keep me', '')).toBe('keep me');
  });

  it('falls back when proper noun dropped', () => {
    expect(
      normalizePolishedContent('Call me alexhong', 'Call me alekhong'),
    ).toBe('Call me alexhong');
  });

  it('accepts good polish', () => {
    expect(
      normalizePolishedContent(
        '記住 比較表用 markdown',
        'User prefers markdown tables for comparisons.',
      ),
    ).toBe('User prefers markdown tables for comparisons.');
  });
});

describe('maybePolishMemoryContent', () => {
  it('skips LLM when disabled', async () => {
    const fetchImpl = vi.fn();
    const r = await maybePolishMemoryContent('raw fact about X', {
      enabled: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ content: 'raw fact about X', polished: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses polished text when LLM ok and tokens preserved', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'User prefers markdown tables for comparisons.',
            },
          },
        ],
      }),
    });
    const r = await maybePolishMemoryContent('比較表用 markdown 就好', {
      enabled: true,
      env: {
        MEMORY_POLISH_ENABLED: 'true',
        OPENAI_MODEL: 'test-model',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // "markdown" must appear in both — polish keeps it
    expect(r.polished).toBe(true);
    expect(r.content).toContain('markdown');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('falls back when LLM drops protected token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'User name is alekhong' } }],
      }),
    });
    const r = await maybePolishMemoryContent('my name is alexhong', {
      enabled: true,
      env: { MEMORY_POLISH_ENABLED: 'true', OPENAI_MODEL: 'm' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.polished).toBe(false);
    expect(r.content).toBe('my name is alexhong');
  });

  it('falls back when LLM fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false });
    const r = await maybePolishMemoryContent('keep original', {
      enabled: true,
      env: { MEMORY_POLISH_ENABLED: 'true', OPENAI_MODEL: 'm' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ content: 'keep original', polished: false });
  });
});
