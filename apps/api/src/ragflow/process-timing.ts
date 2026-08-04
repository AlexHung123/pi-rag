/**
 * Helpers for RAGFlow document parse timing fields
 * (`process_begin_at`, `process_duration`) from the HTTP API.
 */

export type ProcessTimingSource = {
  process_duration?: number | null;
  process_begin_at?: string | null;
  run?: string | number;
};

export type ExtractProcessTimingOptions = {
  now?: number;
  /** Optional status mapper; when status is running and duration is 0, derive from begin_at. */
  mapRunToStatus?: (
    run: string | number | undefined,
  ) => 'unstart' | 'running' | 'done' | 'fail';
};

export function parseProcessBeginAt(
  value: string | null | undefined,
): Date | null {
  if (value == null || String(value).trim() === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function extractProcessTiming(
  rf: ProcessTimingSource,
  opts: ExtractProcessTimingOptions = {},
): { processDuration: number | null; processBeginAt: Date | null } {
  const processBeginAt = parseProcessBeginAt(rf.process_begin_at ?? null);
  const raw =
    typeof rf.process_duration === 'number' && Number.isFinite(rf.process_duration)
      ? rf.process_duration
      : null;

  if (raw != null && raw > 0) {
    return { processDuration: raw, processBeginAt };
  }

  const status = opts.mapRunToStatus?.(rf.run) ?? null;
  if (status === 'running' && processBeginAt) {
    const now = opts.now ?? Date.now();
    const elapsed = Math.max(0, (now - processBeginAt.getTime()) / 1000);
    return {
      processDuration: elapsed > 0 ? elapsed : null,
      processBeginAt,
    };
  }

  return { processDuration: null, processBeginAt };
}

/** Normalize RAGFlow progress_msg which may be string or string[]. */
export function normalizeProgressMsg(
  value: string | string[] | null | undefined,
): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const joined = value.map((s) => String(s).trim()).filter(Boolean).join('\n');
    return joined || null;
  }
  const s = String(value).trim();
  return s || null;
}

/**
 * Prefer stored RAGFlow duration; while running, also derive elapsed from begin time
 * so the UI can tick without waiting for the next RAGFlow poll.
 */
export function effectiveProcessDuration(
  doc: {
    status?: string;
    processDuration?: number | null;
    processBeginAt?: Date | string | null;
  },
  now = Date.now(),
): number | null {
  const stored =
    typeof doc.processDuration === 'number' &&
    Number.isFinite(doc.processDuration) &&
    doc.processDuration > 0
      ? doc.processDuration
      : null;

  let beginMs: number | null = null;
  if (doc.processBeginAt instanceof Date) {
    beginMs = doc.processBeginAt.getTime();
  } else if (typeof doc.processBeginAt === 'string' && doc.processBeginAt) {
    const t = new Date(doc.processBeginAt).getTime();
    if (!Number.isNaN(t)) beginMs = t;
  }

  if (doc.status === 'running' && beginMs != null) {
    const elapsed = Math.max(0, (now - beginMs) / 1000);
    if (elapsed <= 0 && stored == null) return null;
    return Math.max(stored ?? 0, elapsed);
  }

  return stored;
}

/** Human-readable parse duration for admin UI. */
export function formatProcessDuration(
  seconds: number | null | undefined,
): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) {
    const rounded = Math.round(seconds * 10) / 10;
    return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}s`;
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}
