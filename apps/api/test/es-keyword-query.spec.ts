import { describe, expect, it } from 'vitest'
import { getRagRetrievalConfig } from '../src/rag/rag-config'

describe('keyword_search RAGFlow retrieval config', () => {
  it('defaults to pure term ranking (v_weight=0, threshold=0, large top_k)', () => {
    const prev = {
      v: process.env.RAG_KEYWORD_VECTOR_WEIGHT,
      thr: process.env.RAG_KEYWORD_SIMILARITY_THRESHOLD,
      top: process.env.RAG_KEYWORD_TOP_K,
      legacy: process.env.RAG_KEYWORD_ES_TOP_K,
    }
    try {
      delete process.env.RAG_KEYWORD_VECTOR_WEIGHT
      delete process.env.RAG_KEYWORD_SIMILARITY_THRESHOLD
      delete process.env.RAG_KEYWORD_TOP_K
      delete process.env.RAG_KEYWORD_ES_TOP_K
      const cfg = getRagRetrievalConfig()
      expect(cfg.keywordVectorWeight).toBe(0)
      expect(cfg.keywordSimilarityThreshold).toBe(0)
      expect(cfg.keywordTopK).toBe(1024)
    } finally {
      restoreEnv('RAG_KEYWORD_VECTOR_WEIGHT', prev.v)
      restoreEnv('RAG_KEYWORD_SIMILARITY_THRESHOLD', prev.thr)
      restoreEnv('RAG_KEYWORD_TOP_K', prev.top)
      restoreEnv('RAG_KEYWORD_ES_TOP_K', prev.legacy)
    }
  })

  it('accepts legacy RAG_KEYWORD_ES_TOP_K as keywordTopK alias', () => {
    const prev = {
      top: process.env.RAG_KEYWORD_TOP_K,
      legacy: process.env.RAG_KEYWORD_ES_TOP_K,
    }
    try {
      delete process.env.RAG_KEYWORD_TOP_K
      process.env.RAG_KEYWORD_ES_TOP_K = '777'
      const cfg = getRagRetrievalConfig()
      expect(cfg.keywordTopK).toBe(777)
    } finally {
      restoreEnv('RAG_KEYWORD_TOP_K', prev.top)
      restoreEnv('RAG_KEYWORD_ES_TOP_K', prev.legacy)
    }
  })
})

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
