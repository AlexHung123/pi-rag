/**
 * Build short, user-safe tool outcome summaries for SSE / process UI.
 * Never include full chunk text or large payloads.
 */

export type ToolEndSummary = {
  summary: string;
  hitCount?: number;
};

const MAX_SUMMARY_CHARS = 160;
const MAX_QUERY_CHARS = 80;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function detailsFromResult(result: unknown): Record<string, unknown> | null {
  const root = asRecord(result);
  if (!root) return null;
  const details = asRecord(root.details);
  if (details) return details;
  // Some runtimes may pass details at top level
  if ('sources' in root || 'hits' in root || 'query' in root || 'queries' in root) {
    return root;
  }
  return null;
}

function countHits(details: Record<string, unknown>): number | undefined {
  if (Array.isArray(details.sources)) return details.sources.length;
  if (Array.isArray(details.hits)) return details.hits.length;
  if (typeof details.hitCount === 'number' && Number.isFinite(details.hitCount)) {
    return Math.max(0, Math.floor(details.hitCount));
  }
  return undefined;
}

function firstQuery(details: Record<string, unknown>): string | undefined {
  if (typeof details.query === 'string' && details.query.trim()) {
    return details.query.trim();
  }
  if (Array.isArray(details.queries)) {
    const parts = details.queries
      .map((q) => (typeof q === 'string' ? q.trim() : ''))
      .filter(Boolean);
    if (parts.length) return parts.join(' | ');
  }
  return undefined;
}

function errorMessage(details: Record<string, unknown> | null, isError: boolean): string | undefined {
  if (!isError && !details) return undefined;
  const msg =
    (details && typeof details.message === 'string' && details.message.trim()) ||
    undefined;
  return msg;
}

/**
 * Extract a compact summary for tool_execution_end.
 */
export function buildToolEndSummary(
  toolName: string,
  result: unknown,
  isError: boolean,
): ToolEndSummary {
  const name = (toolName || 'tool').trim() || 'tool';
  const details = detailsFromResult(result);
  const errMsg = errorMessage(details, isError);

  if (isError) {
    return {
      summary: clip(errMsg || 'Failed', MAX_SUMMARY_CHARS),
    };
  }

  switch (name) {
    case 'retrieve_chunks':
    case 'keyword_search': {
      // Prefer explicit skip / scope messages over a bare "0 hits"
      if (
        details &&
        (details.skipped === true ||
          (typeof details.message === 'string' &&
            details.message.trim() &&
            countHits(details) === 0))
      ) {
        const msg = String(details.message || '').trim();
        if (msg) {
          return { summary: clip(msg, MAX_SUMMARY_CHARS), hitCount: 0 };
        }
      }
      const hits = countHits(details || {});
      const q = details ? firstQuery(details) : undefined;
      const hitPart =
        hits === undefined
          ? 'Search finished'
          : hits === 1
            ? '1 hit'
            : `${hits} hits`;
      const qPart = q ? ` · ${clip(q, MAX_QUERY_CHARS)}` : '';
      const weak =
        details && details.insufficient === true ? ' · weak match' : '';
      return {
        summary: clip(`${hitPart}${qPart}${weak}`, MAX_SUMMARY_CHARS),
        ...(hits !== undefined ? { hitCount: hits } : {}),
      };
    }
    case 'summarize_document': {
      const hits = countHits(details || {});
      if (details && typeof details.message === 'string' && details.message.trim()) {
        return { summary: clip(details.message, MAX_SUMMARY_CHARS) };
      }
      if (hits !== undefined) {
        return {
          summary: clip(
            hits > 0 ? `Document summary · ${hits} source(s)` : 'Document summary',
            MAX_SUMMARY_CHARS,
          ),
          hitCount: hits,
        };
      }
      return { summary: 'Document summary ready' };
    }
    case 'memory_save':
      return { summary: 'Saved to memory' };
    case 'memory_forget':
      return { summary: 'Removed from memory' };
    case 'memory_list': {
      const items = details && Array.isArray(details.items) ? details.items.length : undefined;
      if (items !== undefined) {
        return {
          summary: clip(
            items === 1 ? 'Listed 1 memory' : `Listed ${items} memories`,
            MAX_SUMMARY_CHARS,
          ),
        };
      }
      return { summary: 'Listed memories' };
    }
    case 'profile_update':
      return { summary: 'Profile updated' };
    default: {
      if (errMsg) return { summary: clip(errMsg, MAX_SUMMARY_CHARS) };
      const hits = details ? countHits(details) : undefined;
      if (hits !== undefined) {
        return {
          summary: clip(hits === 1 ? '1 result' : `${hits} results`, MAX_SUMMARY_CHARS),
          hitCount: hits,
        };
      }
      return { summary: isError ? 'Failed' : 'Done' };
    }
  }
}

/** Short user-facing copy when the run guard blocks a tool. */
export function userFacingLimitMessage(reason: string): string {
  const r = reason || '';
  if (/No knowledge bases or documents selected/i.test(r)) {
    return 'No knowledge bases selected — skipped document search. Select KBs in the UI to search documents.';
  }
  if (/Tool call limit/i.test(r)) {
    return 'Stopped: tool call limit reached. Answering with evidence already found.';
  }
  if (/failed .+ time/i.test(r) || /Do not retry this call/i.test(r)) {
    return 'Stopped retrying a failing tool. Answering with what is available.';
  }
  if (/turn or tool limit|max turns|turns exceeded/i.test(r)) {
    return 'Stopped: agent turn limit reached.';
  }
  return clip(r || 'Agent stopped a tool call.', MAX_SUMMARY_CHARS);
}
