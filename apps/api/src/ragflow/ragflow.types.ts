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
