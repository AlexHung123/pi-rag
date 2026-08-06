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
  /**
   * Max characters of each chunk body in retrieve/keyword tool text.
   * 0 = unlimited (send full chunk content to the LLM).
   */
  maxChunkChars: number;
  /**
   * Hard cap on total characters of formatted evidence in one tool result
   * (retrieve_chunks / keyword_search). Hits beyond the budget are omitted.
   * 0 = no total budget (only per-chunk maxChunkChars applies).
   */
  evidenceMaxChars: number;
  /** Enable multi-query fan-out from a single agent question. */
  multiQueryEnabled: boolean;
  /** Max number of search queries (original + expansions). */
  multiQueryMax: number;
  /** LLM query rewrite before agent prompt (multi-turn). */
  queryRewriteEnabled: boolean;
  /**
   * Keyword path: RAGFlow vector_similarity_weight (0 = pure term ranking).
   * Default 0 — matches POST /api/v1/retrieval keyword-style retrieval.
   */
  keywordVectorWeight: number;
  /** Drop keyword hits below this similarity (default 0). */
  keywordSimilarityThreshold: number;
  /**
   * Keyword path candidate pool (RAGFlow top_k). Default 1024.
   */
  keywordTopK: number;
  /** listChunks page size when loading a full document for summarize. */
  summarizeListPageSize: number;
  /**
   * Per-chunk body cap when formatting full-text evidence for the agent.
   * 0 = unlimited (only RAG_SUMMARIZE_MAX_TOTAL_CHARS applies).
   */
  summarizeMaxChunkChars: number;
  /**
   * Hard cap on total characters of summarize_document tool text
   * (header + all chunks). 0 = no total budget.
   */
  summarizeMaxTotalChars: number;
};

export function getRagRetrievalConfig(): RagRetrievalConfig {
  // Evidence chunks returned to the LLM (retrieve/keyword after filter).
  const pageSize = Math.min(50, Math.max(1, envInt('RAG_PAGE_SIZE', 50)));
  // Over-retrieve candidate pool for semantic path (must be >= pageSize).
  const topK = Math.min(
    150,
    Math.max(pageSize, envInt('RAG_TOP_K', Math.min(150, pageSize * 3))),
  );
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
    // Per-chunk body cap for retrieve/keyword tool text (default 4000).
    // Set RAG_MAX_CHUNK_CHARS=0 only if you intentionally want full chunks.
    maxChunkChars: Math.max(0, envInt('RAG_MAX_CHUNK_CHARS', 4000)),
    // Total tool-result budget so one keyword/retrieve call cannot blow the
    // model context window (≈ chars; 120k chars ≈ 30k–60k tokens depending
    // on language/HTML density). 0 disables the total cap.
    evidenceMaxChars: Math.max(0, envInt('RAG_EVIDENCE_MAX_CHARS', 120_000)),
    multiQueryEnabled: envBool('RAG_MULTI_QUERY', true),
    multiQueryMax: Math.min(5, Math.max(1, envInt('RAG_MULTI_QUERY_MAX', 3))),
    // Off by default: agent builds its own retrieval questions from history.
    queryRewriteEnabled: envBool('RAG_QUERY_REWRITE', false),
    keywordVectorWeight: Math.min(
      1,
      Math.max(0, envFloat('RAG_KEYWORD_VECTOR_WEIGHT', 0)),
    ),
    keywordSimilarityThreshold: Math.min(
      1,
      Math.max(0, envFloat('RAG_KEYWORD_SIMILARITY_THRESHOLD', 0)),
    ),
    // Prefer RAG_KEYWORD_TOP_K; accept legacy RAG_KEYWORD_ES_TOP_K as alias.
    keywordTopK: Math.min(
      5000,
      Math.max(
        1,
        envInt(
          'RAG_KEYWORD_TOP_K',
          envInt('RAG_KEYWORD_ES_TOP_K', 1024),
        ),
      ),
    ),
    summarizeListPageSize: Math.min(
      100,
      Math.max(10, envInt('RAG_SUMMARIZE_LIST_PAGE_SIZE', 50)),
    ),
    // Per-chunk body cap for summarize_document (default 4000).
    // Set RAG_SUMMARIZE_MAX_CHUNK_CHARS=0 to send full chunks (total budget still applies).
    summarizeMaxChunkChars: Math.max(
      0,
      envInt('RAG_SUMMARIZE_MAX_CHUNK_CHARS', 4000),
    ),
    // Full-document summarize body budget (default 80k chars).
    summarizeMaxTotalChars: Math.max(
      0,
      envInt('RAG_SUMMARIZE_MAX_TOTAL_CHARS', 80_000),
    ),
  };
}
