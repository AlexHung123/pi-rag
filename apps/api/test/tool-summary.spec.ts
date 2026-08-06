import { describe, expect, it } from 'vitest';
import {
  buildToolEndSummary,
  userFacingLimitMessage,
} from '../src/agent/tool-summary';

describe('buildToolEndSummary', () => {
  it('summarizes retrieve_chunks with hits and query', () => {
    const out = buildToolEndSummary(
      'retrieve_chunks',
      {
        details: {
          sources: [{ id: '1' }, { id: '2' }],
          queries: ['What is Q3 plan?'],
          insufficient: false,
        },
      },
      false,
    );
    expect(out.hitCount).toBe(2);
    expect(out.summary).toMatch(/2 hits/);
    expect(out.summary).toMatch(/Q3/);
  });

  it('summarizes keyword_search weak match', () => {
    const out = buildToolEndSummary(
      'keyword_search',
      {
        details: {
          hits: [],
          query: 'ERR-1234',
          insufficient: true,
        },
      },
      false,
    );
    expect(out.hitCount).toBe(0);
    expect(out.summary).toMatch(/0 hits/);
    expect(out.summary).toMatch(/ERR-1234/);
    expect(out.summary).toMatch(/weak/i);
  });

  it('prefers skip/scope message over bare 0 hits', () => {
    const out = buildToolEndSummary(
      'keyword_search',
      {
        details: {
          hits: [],
          sources: [],
          skipped: true,
          message:
            'No knowledge bases or documents selected. Do not call retrieve_chunks.',
        },
      },
      false,
    );
    expect(out.hitCount).toBe(0);
    expect(out.summary).toMatch(/No knowledge bases/i);
    expect(out.summary).not.toMatch(/^0 hits/);
  });

  it('uses error message when isError', () => {
    const out = buildToolEndSummary(
      'retrieve_chunks',
      { details: { message: 'scope denied' } },
      true,
    );
    expect(out.summary).toBe('scope denied');
    expect(out.hitCount).toBeUndefined();
  });

  it('summarizes memory tools', () => {
    expect(buildToolEndSummary('memory_save', { details: { ok: true } }, false).summary).toMatch(
      /Saved/i,
    );
    expect(
      buildToolEndSummary(
        'memory_list',
        { details: { items: [{ id: 'a' }, { id: 'b' }] } },
        false,
      ).summary,
    ).toMatch(/2 memories/);
  });

  it('clips long queries', () => {
    const long = 'x'.repeat(200);
    const out = buildToolEndSummary(
      'keyword_search',
      { details: { sources: [{ id: '1' }], query: long } },
      false,
    );
    expect(out.summary.length).toBeLessThanOrEqual(160);
    expect(out.summary).toMatch(/…$/);
  });
});

describe('userFacingLimitMessage', () => {
  it('maps tool call limit', () => {
    expect(
      userFacingLimitMessage('Tool call limit reached (15 max). Do not call more tools.'),
    ).toMatch(/tool call limit/i);
  });

  it('maps retry block', () => {
    expect(
      userFacingLimitMessage(
        'Tool "keyword_search" failed 2 time(s) with the same arguments (max 2).',
      ),
    ).toMatch(/retry/i);
  });
});
