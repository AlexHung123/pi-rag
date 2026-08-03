import { describe, expect, it } from 'vitest';
import {
  buildMemoryPromptBlock,
  estimateTokens,
  getMemoryPromptSettings,
  matchMemoryItemsByQuery,
  selectMemoryItems,
  type MemoryItemForPrompt,
  type ProfileForPrompt,
} from '../src/memory/memory-prompt';

function item(
  partial: Partial<MemoryItemForPrompt> & { id: string; content: string },
): MemoryItemForPrompt {
  return {
    category: 'other',
    pinned: false,
    importance: 3,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...partial,
  };
}

describe('getMemoryPromptSettings', () => {
  it('defaults enabled with locked budgets', () => {
    const s = getMemoryPromptSettings({});
    expect(s.enabled).toBe(true);
    expect(s.maxTokens).toBe(2000);
    expect(s.maxItems).toBe(15);
    expect(s.maxPinned).toBe(15);
  });

  it('can disable via env', () => {
    expect(
      getMemoryPromptSettings({ MEMORY_INJECTION_ENABLED: 'false' }).enabled,
    ).toBe(false);
  });
});

describe('selectMemoryItems', () => {
  it('orders pinned first then importance then recency', () => {
    const items = [
      item({
        id: 'a',
        content: 'low',
        importance: 1,
        updatedAt: new Date('2026-06-01'),
      }),
      item({
        id: 'b',
        content: 'pin',
        pinned: true,
        importance: 1,
        updatedAt: new Date('2026-01-01'),
      }),
      item({
        id: 'c',
        content: 'high',
        importance: 5,
        updatedAt: new Date('2026-03-01'),
      }),
      item({
        id: 'd',
        content: 'mid-newer',
        importance: 5,
        updatedAt: new Date('2026-05-01'),
      }),
    ];
    const selected = selectMemoryItems(items, 3);
    expect(selected.map((x) => x.id)).toEqual(['b', 'd', 'c']);
  });

  it('respects maxItems', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      item({ id: `i${i}`, content: `c${i}`, importance: i }),
    );
    expect(selectMemoryItems(items, 15)).toHaveLength(15);
  });
});

describe('buildMemoryPromptBlock', () => {
  const emptyProfile: ProfileForPrompt = {
    displayName: null,
    language: null,
    responseStyle: null,
    bio: '',
    prefs: {},
  };

  it('returns empty string when disabled', () => {
    const block = buildMemoryPromptBlock({
      profile: {
        ...emptyProfile,
        displayName: 'Ming',
      },
      items: [item({ id: '1', content: 'fact' })],
      settings: { enabled: false, maxTokens: 2000, maxItems: 15, maxPinned: 15 },
    });
    expect(block).toBe('');
  });

  it('returns empty when profile empty and no items', () => {
    const block = buildMemoryPromptBlock({
      profile: emptyProfile,
      items: [],
      settings: { enabled: true, maxTokens: 2000, maxItems: 15, maxPinned: 15 },
    });
    expect(block).toBe('');
  });

  it('includes profile fields and memory lines', () => {
    const block = buildMemoryPromptBlock({
      profile: {
        displayName: '阿明',
        language: 'zh-Hant',
        responseStyle: 'short',
        bio: 'CSB KB',
        prefs: { noEmoji: true },
      },
      items: [
        item({
          id: '1',
          content: 'Use markdown tables',
          category: 'preference',
          pinned: true,
        }),
      ],
      settings: { enabled: true, maxTokens: 2000, maxItems: 15, maxPinned: 15 },
    });
    expect(block).toContain('[User profile & memory');
    expect(block).toContain('阿明');
    expect(block).toContain('zh-Hant');
    expect(block).toContain('Use markdown tables');
    expect(block).toContain('[preference][pinned]');
  });

  it('matchMemoryItemsByQuery matches id then content substring', () => {
    const items = [
      { id: 'uuid-1', content: 'Prefer short answers' },
      { id: 'uuid-2', content: 'Project pi-rag memory MVP' },
    ];
    expect(matchMemoryItemsByQuery(items, 'uuid-2').map((x) => x.id)).toEqual([
      'uuid-2',
    ]);
    expect(
      matchMemoryItemsByQuery(items, 'short answers').map((x) => x.id),
    ).toEqual(['uuid-1']);
    expect(matchMemoryItemsByQuery(items, 'nope')).toEqual([]);
  });

  it('drops lowest-priority items to stay under token budget', () => {
    // ~800 tokens each via chars/4
    const long = 'x'.repeat(3200);
    const items = [
      item({ id: 'pin', content: `PINNED-${long}`, pinned: true, importance: 5 }),
      item({ id: 'a', content: `HIGH-${long}`, importance: 4 }),
      item({ id: 'b', content: `LOW-${long}`, importance: 1 }),
    ];
    const block = buildMemoryPromptBlock({
      profile: emptyProfile,
      items,
      settings: { enabled: true, maxTokens: 1000, maxItems: 15, maxPinned: 15 },
    });
    expect(estimateTokens(block)).toBeLessThanOrEqual(1000);
    expect(block).toMatch(/\[other\]\[pinned\]/);
    expect(block).toContain('PINNED-');
  });
});
