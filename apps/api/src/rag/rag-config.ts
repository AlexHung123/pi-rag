/**
 * Server-side RAG defaults (env-overridable).
 * Keeps retrieval tuning out of ad-hoc magic numbers in tools.
 */

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export type RagRetrievalConfig = {
  /** Chunks returned to the agent / UI after filtering. */
  pageSize: number;
  /** Over-retrieve candidate count sent to RAGFlow as top_k. */
  topK: number;
  /** Drop hits below this similarity (when score is present). */
  similarityThreshold: number;
  /**
   * Hybrid mix: 1 = pure vector, 0 = pure keyword (RAGFlow vector_similarity_weight).
   */
  vectorSimilarityWeight: number;
  /** Optional RAGFlow rerank model id. */
  rerankId: string | undefined;
  /** Max characters of each chunk body in the tool text payload. */
  maxChunkChars: number;
  /** Enable multi-query fan-out from a single agent question. */
  multiQueryEnabled: boolean;
  /** Max number of search queries (original + expansions). */
  multiQueryMax: number;
  /** LLM query rewrite before agent prompt (multi-turn). */
  queryRewriteEnabled: boolean;
};

export function getRagRetrievalConfig(): RagRetrievalConfig {
  const pageSize = Math.min(20, Math.max(1, envInt('RAG_PAGE_SIZE', 10)));
  // Over-retrieve: default ~3x page size, cap 50 (RAGFlow-friendly).
  const topK = Math.min(50, Math.max(pageSize, envInt('RAG_TOP_K', pageSize * 3)));
  return {
    pageSize,
    topK,
    similarityThreshold: Math.min(
      1,
      Math.max(0, envFloat('RAG_SIMILARITY_THRESHOLD', 0.2)),
    ),
    vectorSimilarityWeight: Math.min(
      1,
      Math.max(0, envFloat('RAG_VECTOR_SIMILARITY_WEIGHT', 0.7)),
    ),
    rerankId: (process.env.RAG_RERANK_ID || '').trim() || undefined,
    maxChunkChars: Math.min(
      8000,
      Math.max(200, envInt('RAG_MAX_CHUNK_CHARS', 1200)),
    ),
    multiQueryEnabled: envBool('RAG_MULTI_QUERY', true),
    multiQueryMax: Math.min(5, Math.max(1, envInt('RAG_MULTI_QUERY_MAX', 3))),
    queryRewriteEnabled: envBool('RAG_QUERY_REWRITE', true),
  };
}
