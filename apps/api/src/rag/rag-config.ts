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
  /**
   * Keyword path: low vector weight → prefer term/ES similarity
   * (RAGFlow: score = w * vector + (1-w) * term).
   */
  keywordVectorWeight: number;
  /** Slightly lower threshold for literal / keyword hits. */
  keywordSimilarityThreshold: number;
  /**
   * Pass RAGFlow `keyword: true` so retrieval uses ElasticSearch keyword matching
   * in addition to hybrid ranking.
   */
  keywordEnableEs: boolean;
  /** Total char budget for list_document_chunks evidence. */
  listDocCharBudget: number;
  /** Hard cap on pageSize for list_document_chunks. */
  listDocPageSizeMax: number;
  /**
   * P1d: attach previous/next chunk from listChunks order for top hits.
   * Uses document list order (stable); fail-open if chunk not found.
   */
  adjacentExpandEnabled: boolean;
  /** Max primary hits to expand with neighbors. */
  adjacentExpandMaxHits: number;
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
    keywordVectorWeight: Math.min(
      1,
      Math.max(0, envFloat('RAG_KEYWORD_VECTOR_WEIGHT', 0.1)),
    ),
    keywordSimilarityThreshold: Math.min(
      1,
      Math.max(0, envFloat('RAG_KEYWORD_SIMILARITY_THRESHOLD', 0.1)),
    ),
    keywordEnableEs: envBool('RAG_KEYWORD_ENABLE_ES', true),
    listDocCharBudget: Math.min(
      20_000,
      Math.max(1000, envInt('RAG_LIST_DOC_CHAR_BUDGET', 7000)),
    ),
    listDocPageSizeMax: Math.min(
      50,
      Math.max(1, envInt('RAG_LIST_DOC_PAGE_SIZE_MAX', 20)),
    ),
    adjacentExpandEnabled: envBool('RAG_ADJACENT_EXPAND', true),
    adjacentExpandMaxHits: Math.min(
      10,
      Math.max(1, envInt('RAG_ADJACENT_EXPAND_MAX_HITS', 3)),
    ),
  };
}
