import { describe, expect, it } from 'vitest';
import {
  clipTextToBudget,
  formatEvidenceForModel,
  truncateChunk,
  type MappedHit,
} from '../src/rag/evidence';

function hit(i: number, content: string): MappedHit {
  return {
    id: `h${i}`,
    content,
    documentName: `doc-${i}.pdf`,
    score: 0.9 - i * 0.01,
  };
}

describe('truncateChunk / clipTextToBudget', () => {
  it('truncateChunk: 0 means unlimited', () => {
    const long = 'a'.repeat(500);
    expect(truncateChunk(long, 0)).toBe(long);
    expect(truncateChunk(long, 10).length).toBeLessThanOrEqual(11);
  });

  it('clipTextToBudget keeps head and tail', () => {
    const t = 'HEAD' + 'x'.repeat(200) + 'TAIL';
    const out = clipTextToBudget(t, 80);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toContain('truncated');
  });
});

describe('formatEvidenceForModel budget', () => {
  it('includes full bodies when under budget', () => {
    const hits = [hit(1, 'alpha'), hit(2, 'beta')];
    const text = formatEvidenceForModel(hits, {
      maxChunkChars: 100,
      maxTotalChars: 50_000,
      query: 'q',
    });
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(text).not.toContain('truncated');
  });

  it('applies per-chunk maxChunkChars', () => {
    const hits = [hit(1, 'A'.repeat(100))];
    const text = formatEvidenceForModel(hits, { maxChunkChars: 20 });
    expect(text).toContain('…');
    expect(text).not.toContain('A'.repeat(100));
  });

  it('omits later hits when maxTotalChars is exceeded', () => {
    const hits = Array.from({ length: 20 }, (_, i) =>
      hit(i + 1, `body-${i}-` + 'z'.repeat(200)),
    );
    const text = formatEvidenceForModel(hits, {
      maxChunkChars: 0,
      maxTotalChars: 800,
      query: 'big',
    });
    expect(text.length).toBeLessThanOrEqual(900);
    expect(text).toMatch(/truncated \d+ more chunk/);
    // First hit should still appear
    expect(text).toContain('body-0-');
  });

  it('maxTotalChars 0 means no total budget', () => {
    const hits = [hit(1, 'x'.repeat(50)), hit(2, 'y'.repeat(50))];
    const text = formatEvidenceForModel(hits, {
      maxChunkChars: 0,
      maxTotalChars: 0,
    });
    expect(text).toContain('x'.repeat(50));
    expect(text).toContain('y'.repeat(50));
  });
});
