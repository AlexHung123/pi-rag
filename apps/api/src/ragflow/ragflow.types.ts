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

export type RagflowChunk = {
  id: string;
  content?: string;
  content_with_weight?: string;
  document_id?: string;
  available?: boolean;
  important_keywords?: string[];
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
};
