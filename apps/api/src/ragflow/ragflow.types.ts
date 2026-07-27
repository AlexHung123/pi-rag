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
  progress_msg?: string;
  chunk_count?: number;
  chunk_method?: string;
  status?: string;
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

export type RetrieveHit = {
  id: string;
  content: string;
  documentId?: string;
  documentName?: string;
  score?: number;
  datasetId?: string;
  /** PDF highlight boxes when returned by retrieval. */
  positions?: RagflowChunkPosition[];
};

/** Options for RAGFlow POST /api/v1/retrieval */
export type RetrieveOptions = {
  datasetIds: string[];
  question: string;
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
};
