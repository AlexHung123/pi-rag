import { describe, expect, it } from 'vitest';
import {
  effectiveProcessDuration,
  extractProcessTiming,
  formatProcessDuration,
  normalizeProgressMsg,
  parseProcessBeginAt,
} from '../src/ragflow/process-timing';

describe('parseProcessBeginAt', () => {
  it('parses RFC-like date strings from RAGFlow', () => {
    const d = parseProcessBeginAt('Wed, 17 Dec 2025 10:33:55 GMT');
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe('2025-12-17T10:33:55.000Z');
  });

  it('returns null for empty / invalid', () => {
    expect(parseProcessBeginAt(null)).toBeNull();
    expect(parseProcessBeginAt(undefined)).toBeNull();
    expect(parseProcessBeginAt('')).toBeNull();
    expect(parseProcessBeginAt('not-a-date')).toBeNull();
  });
});

describe('extractProcessTiming', () => {
  it('uses process_duration when positive', () => {
    const t = extractProcessTiming({
      process_duration: 14.8615,
      process_begin_at: 'Wed, 17 Dec 2025 10:33:55 GMT',
    });
    expect(t.processDuration).toBeCloseTo(14.8615, 4);
    expect(t.processBeginAt?.toISOString()).toBe('2025-12-17T10:33:55.000Z');
  });

  it('treats zero duration as null when not running', () => {
    const t = extractProcessTiming({
      process_duration: 0,
      process_begin_at: null,
      run: 'UNSTART',
    });
    expect(t.processDuration).toBeNull();
    expect(t.processBeginAt).toBeNull();
  });

  it('derives elapsed seconds from process_begin_at while running if duration is 0', () => {
    const begin = new Date(Date.now() - 12_500);
    const t = extractProcessTiming(
      {
        process_duration: 0,
        process_begin_at: begin.toUTCString(),
        run: 'RUNNING',
      },
      { now: Date.now(), mapRunToStatus: () => 'running' },
    );
    expect(t.processDuration).toBeGreaterThanOrEqual(12);
    expect(t.processDuration).toBeLessThan(14);
    expect(t.processBeginAt).toBeInstanceOf(Date);
  });
});

describe('normalizeProgressMsg', () => {
  it('joins array progress messages', () => {
    expect(
      normalizeProgressMsg(['line1', 'line2']),
    ).toBe('line1\nline2');
  });

  it('keeps string messages', () => {
    expect(normalizeProgressMsg('Task done')).toBe('Task done');
  });

  it('returns null for empty', () => {
    expect(normalizeProgressMsg(undefined)).toBeNull();
    expect(normalizeProgressMsg('')).toBeNull();
    expect(normalizeProgressMsg([])).toBeNull();
  });
});

describe('formatProcessDuration', () => {
  it('formats under a minute', () => {
    expect(formatProcessDuration(14.8615)).toBe('14.9s');
    expect(formatProcessDuration(0.54)).toBe('0.5s');
  });

  it('formats minutes and hours', () => {
    expect(formatProcessDuration(75)).toBe('1m 15s');
    expect(formatProcessDuration(3661)).toBe('1h 1m 1s');
  });

  it('returns em dash for missing/zero', () => {
    expect(formatProcessDuration(null)).toBe('—');
    expect(formatProcessDuration(undefined)).toBe('—');
    expect(formatProcessDuration(0)).toBe('—');
  });
});

describe('effectiveProcessDuration', () => {
  it('returns stored duration for done docs', () => {
    expect(
      effectiveProcessDuration({
        status: 'done',
        processDuration: 14.8,
        processBeginAt: new Date('2025-12-17T10:33:55Z'),
      }),
    ).toBeCloseTo(14.8, 4);
  });

  it('ticks elapsed while running from processBeginAt', () => {
    const begin = new Date(Date.now() - 30_000);
    const v = effectiveProcessDuration(
      {
        status: 'running',
        processDuration: 5,
        processBeginAt: begin,
      },
      Date.now(),
    );
    expect(v).toBeGreaterThanOrEqual(29);
    expect(v).toBeLessThan(32);
  });
});
