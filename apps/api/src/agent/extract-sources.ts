/**
 * Recover citation sources from agent tool-result messages (current turn only).
 */

import {
  mergeCitationSources,
  type CitationSource,
} from '../rag/evidence';

/** Tools that may attach details.sources for the citation UI. */
export const RETRIEVAL_TOOL_NAMES = new Set([
  'retrieve_chunks',
  'keyword_search',
  'summarize_document',
]);

function mapHitsToSources(hits: unknown[]): CitationSource[] {
  return hits.map((h, i) => {
    const hit = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
    const score = typeof hit.score === 'number' ? hit.score : undefined;
    return {
      id: String(hit.id || `hit-${i + 1}`),
      content: String(hit.content || ''),
      documentName:
        typeof hit.documentName === 'string' ? hit.documentName : undefined,
      documentId:
        typeof hit.documentId === 'string' ? hit.documentId : undefined,
      appDocumentId:
        typeof hit.appDocumentId === 'string' ? hit.appDocumentId : undefined,
      knowledgeBaseId:
        typeof hit.knowledgeBaseId === 'string'
          ? hit.knowledgeBaseId
          : undefined,
      knowledgeBaseName:
        typeof hit.knowledgeBaseName === 'string'
          ? hit.knowledgeBaseName
          : undefined,
      score,
      index: typeof hit.index === 'number' ? hit.index : i + 1,
      evidenceLabel:
        typeof hit.evidenceLabel === 'string'
          ? hit.evidenceLabel
          : typeof score === 'number' && score >= 0.75
            ? 'Strong evidence'
            : typeof score === 'number' && score >= 0.5
              ? 'Moderate evidence'
              : 'Evidence',
      positions: Array.isArray(hit.positions)
        ? (hit.positions as number[][])
        : undefined,
    } satisfies CitationSource;
  });
}

export function extractSourcesFromToolResult(result: unknown): CitationSource[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as {
    details?: unknown;
    content?: unknown;
  };

  // Prefer structured details from retrieve_chunks
  if (r.details && typeof r.details === 'object') {
    const d = r.details as { sources?: unknown; hits?: unknown };
    if (Array.isArray(d.sources) && d.sources.length) {
      return d.sources as CitationSource[];
    }
    if (Array.isArray(d.hits) && d.hits.length) {
      return mapHitsToSources(d.hits);
    }
  }

  // Fallback: parse JSON text content from the tool result
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (!block || typeof block !== 'object') continue;
      const text = String((block as { text?: string }).text || '');
      if (!text.trim()) continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed) && parsed.length) {
          return mapHitsToSources(parsed);
        }
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as { hits?: unknown; sources?: unknown };
          if (Array.isArray(obj.sources) && obj.sources.length) {
            return obj.sources as CitationSource[];
          }
          if (Array.isArray(obj.hits) && obj.hits.length) {
            return mapHitsToSources(obj.hits);
          }
        }
      } catch {
        /* not JSON */
      }
    }
  }

  return [];
}

/**
 * Scan agent message history for retrieval tool results (this turn only).
 * Merges sources from retrieve_chunks / keyword_search / summarize_document.
 *
 * Walks backward from the end and stops at the latest user message so prior
 * turns' tool results never leak into a greeting / no-tool reply.
 */
export function extractSourcesFromAgentMessages(
  messages: Array<{
    role: string;
    content?: unknown;
    details?: unknown;
    toolName?: string;
  }>,
): CitationSource[] {
  const batches: CitationSource[][] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const role = String(m.role || '');
    // Boundary of the current turn — do not scan older tool results.
    if (role === 'user') break;
    if (role === 'toolResult' || role === 'tool') {
      const toolName = String(m.toolName || '');
      if (toolName && !RETRIEVAL_TOOL_NAMES.has(toolName)) continue;
      // If toolName missing, still try to parse details.sources
      const fromDetails = extractSourcesFromToolResult({
        details: m.details,
        content: m.content,
      });
      if (fromDetails.length) batches.push(fromDetails);
    }
  }
  if (!batches.length) return [];
  return mergeCitationSources(...batches);
}
