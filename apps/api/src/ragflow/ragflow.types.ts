export type RagflowDataset = {
  id: string;
  name: string;
  chunk_method?: string;
  description?: string;
};

export type RagflowDocument = {
  id: string;
  name: string;
  size?: number;
  run?: string | number;
  progress?: number;
  /** String or line array depending on RAGFlow version. */
  progress_msg?: string | string[];
  chunk_count?: number;
  chunk_method?: string;
  status?: string;
  /** When parse started (RFC string from RAGFlow, or null). */
  process_begin_at?: string | null;
  /** Parse duration in seconds. */
  process_duration?: number;
};

/**
 * RAGFlow chunk source box: [pageNumber, x1, x2, y1, y2]
 * Coordinates are in PDF page space (pdf.js viewport scale=1).
 */
export type RagflowChunkPosition = [number, number, number, number, number] | number[];

export type RagflowChunk = {
  id: string;
  content?: string;
  content_with_weight?: string;
  document_id?: string;
  available?: boolean;
  important_keywords?: string[];
  /** Source locations for PDF highlight (RAGFlow list-chunks / retrieval). */
  positions?: RagflowChunkPosition[];
  image_id?: string;
};

export type CreateDatasetInput = {
  name: string;
  description?: string;
  chunkMethod?: string;
  parserConfig?: Record<string, unknown>;
};

/** RAGFlow POST .../documents/{id}/chunks */
export type AddChunkInput = {
  content: string;
  importantKeywords?: string[];
  questions?: string[];
};

/** RAGFlow PATCH .../chunks/{chunkId} */
export type UpdateChunkInput = {
  content?: string;
  importantKeywords?: string[];
  questions?: string[];
  available?: boolean;
};

export type RetrieveHit = {
  id: string;
  content: string;
  documentId?: string;
  documentName?: string;
  /** Overall similarity (RAGFlow `similarity` / `score`). */
  score?: number;
  /** Term/full-text similarity when RAGFlow returns `term_similarity`. */
  termSimilarity?: number;
  /** Vector similarity when RAGFlow returns `vector_similarity`. */
  vectorSimilarity?: number;
  /** Highlight HTML with matched terms in <em> (when highlight=true). */
  highlight?: string;
  datasetId?: string;
  /** PDF highlight boxes when returned by retrieval. */
  positions?: RagflowChunkPosition[];
};

/** Options for RAGFlow POST /api/v1/retrieval */
export type RetrieveOptions = {
  datasetIds: string[];
  question: string;
  /** 1-based page (RAGFlow `page`). */
  page?: number;
  /** Final page size (chunks returned after RAGFlow ranking). */
  pageSize?: number;
  /**
   * Candidate pool size (RAGFlow top_k). Prefer larger than pageSize
   * so hybrid/rerank can re-order before truncation.
   */
  topK?: number;
  /** Drop results below this similarity when the engine scores them. */
  similarityThreshold?: number;
  /** 1 = pure vector, 0 = pure keyword (RAGFlow vector_similarity_weight). */
  vectorSimilarityWeight?: number;
  /** Optional document filter (RAGFlow document ids). */
  documentIds?: string[];
  /** Optional RAGFlow rerank model id. */
  rerankId?: string;
  /**
   * When true, RAGFlow enables extra keyword-based matching
   * (`keyword: true` on POST /api/v1/retrieval).
   */
  keyword?: boolean;
  /** When true, RAGFlow wraps matched terms in the returned content. */
  highlight?: boolean;
};

/**
 * Options for keyword_search via RAGFlow POST /api/v1/retrieval
 * (pure term ranking: vector_similarity_weight=0, highlight=true).
 */
export type KeywordSearchOptions = {
  datasetIds: string[];
  /** Keyword / name / code / phrase to match. */
  question: string;
  /** Optional RAGFlow document ids hard filter. */
  documentIds?: string[];
  /** Chunks returned (RAGFlow page_size). */
  pageSize?: number;
  /** Candidate pool (RAGFlow top_k, default RAG_KEYWORD_TOP_K). */
  topK?: number;
};
