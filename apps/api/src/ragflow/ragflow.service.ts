import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import {
  AddChunkInput,
  CreateDatasetInput,
  KeywordSearchOptions,
  RagflowChunk,
  RagflowDataset,
  RagflowDocument,
  RetrieveHit,
  RetrieveOptions,
  UpdateChunkInput
} from './ragflow.types'
import { RagflowMockStore } from './ragflow-mock.store'
import { badRequest } from '../common/errors'
import { getRagRetrievalConfig } from '../rag/rag-config'

type ApiEnvelope<T> = { code: number; message?: string; data?: T }

/** RAGFlow POST /api/v1/retrieval rejects page_size above this (code=100). */
const RAGFLOW_RETRIEVAL_MAX_PAGE_SIZE = 100

@Injectable()
export class RagflowService implements OnModuleInit {
  private readonly logger = new Logger(RagflowService.name)
  private readonly mock = new RagflowMockStore()
  private mockBootWarned = false

  useMock(): boolean {
    const mockEnv = (process.env.RAGFLOW_MOCK || '').toLowerCase()
    if (mockEnv === 'true') return true
    if (mockEnv === 'false') return false
    return !process.env.RAGFLOW_API_KEY
  }

  /**
   * Production must not silently fall into in-memory mock (data would not persist
   * in RAGFlow). Dev may auto-mock when API key is missing, with a loud warning.
   */
  onModuleInit() {
    const mockEnv = (process.env.RAGFLOW_MOCK || '').toLowerCase()
    const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production'
    const hasKey = Boolean((process.env.RAGFLOW_API_KEY || '').trim())

    if (isProd) {
      if (mockEnv === 'true') {
        this.logger.warn(
          'RAGFLOW_MOCK=true in production: using in-memory mock (no real RAGFlow). ' +
            'Data is lost on restart and is not shared across instances.'
        )
        return
      }
      if (!hasKey) {
        throw new Error(
          'RAGFLOW_API_KEY is required when NODE_ENV=production ' +
            '(or set RAGFLOW_MOCK=true only if you intentionally want the in-memory mock).'
        )
      }
      return
    }

    if (this.useMock()) {
      this.warnMockActive(mockEnv === 'true' ? 'RAGFLOW_MOCK=true' : 'no RAGFLOW_API_KEY (dev auto-mock)')
    }
  }

  private warnMockActive(reason: string) {
    if (this.mockBootWarned) return
    this.mockBootWarned = true
    this.logger.warn(
      `╔══════════════════════════════════════════════════════════════╗\n` +
        `║  RAGFlow MOCK is ACTIVE (${reason})                          \n` +
        `║  Uploads/parse/retrieve use process memory only.             \n` +
        `║  Set RAGFLOW_API_KEY (+ RAGFLOW_BASE_URL) for real RAGFlow,  \n` +
        `║  or RAGFLOW_MOCK=false to force real API.                    \n` +
        `╚══════════════════════════════════════════════════════════════╝`
    )
  }

  private baseUrl(): string {
    return (process.env.RAGFLOW_BASE_URL || 'http://localhost:9380').replace(/\/$/, '')
  }

  private headers(json = true): Record<string, string> {
    const key = process.env.RAGFLOW_API_KEY || ''
    const h: Record<string, string> = {
      Authorization: `Bearer ${key}`
    }
    if (json) h['Content-Type'] = 'application/json'
    return h
  }

  private async request<T>(method: string, path: string, init?: { body?: unknown; form?: FormData; signal?: AbortSignal }): Promise<T> {
    const url = `${this.baseUrl()}${path}`
    const headers = this.headers(!init?.form)
    if (init?.form) {
      delete headers['Content-Type']
    }
    const res = await fetch(url, {
      method,
      headers,
      body: init?.form ? (init.form as unknown as BodyInit) : init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init?.signal
    })
    const text = await res.text()
    let json: ApiEnvelope<T>
    try {
      json = JSON.parse(text) as ApiEnvelope<T>
    } catch {
      throw badRequest(`RAGFlow invalid response (${res.status}): ${text.slice(0, 200)}`)
    }
    if (json.code !== 0) {
      throw badRequest(json.message || `RAGFlow error code ${json.code}`)
    }
    return json.data as T
  }

  async createDataset(input: CreateDatasetInput): Promise<RagflowDataset> {
    if (this.useMock()) {
      this.logger.debug(`mock createDataset ${input.name}`)
      return this.mock.createDataset(input)
    }
    const data = await this.request<RagflowDataset>('POST', '/api/v1/datasets', {
      body: {
        name: input.name,
        description: input.description || '',
        chunk_method: input.chunkMethod || 'naive',
        ...(input.parserConfig ? { parser_config: input.parserConfig } : {})
      }
    })
    return data
  }

  async deleteDatasets(ids: string[]): Promise<void> {
    if (this.useMock()) {
      for (const id of ids) this.mock.deleteDataset(id)
      return
    }
    await this.request('DELETE', '/api/v1/datasets', { body: { ids } })
  }

  async uploadDocuments(
    datasetId: string,
    files: Array<{ filename: string; buffer: Buffer; mimetype?: string }>
  ): Promise<RagflowDocument[]> {
    if (this.useMock()) {
      return this.mock.uploadDocuments(
        datasetId,
        files.map(f => ({ filename: f.filename, buffer: f.buffer }))
      )
    }
    const form = new FormData()
    for (const f of files) {
      const blob = new Blob([new Uint8Array(f.buffer)], {
        type: f.mimetype || 'application/octet-stream'
      })
      form.append('file', blob, f.filename)
    }
    const data = await this.request<RagflowDocument[]>('POST', `/api/v1/datasets/${datasetId}/documents`, { form })
    return Array.isArray(data) ? data : []
  }

  /**
   * Create an empty virtual document (no file bytes).
   * RAGFlow: POST /api/v1/datasets/{dataset_id}/documents?type=empty
   * Body: { name: string }
   */
  async createEmptyDocument(datasetId: string, name: string): Promise<RagflowDocument> {
    if (this.useMock()) {
      return this.mock.createEmptyDocument(datasetId, name)
    }
    const data = await this.request<RagflowDocument[] | RagflowDocument>(
      'POST',
      `/api/v1/datasets/${datasetId}/documents?type=empty`,
      { body: { name } }
    )
    if (Array.isArray(data)) {
      const doc = data[0]
      if (!doc?.id) throw badRequest('RAGFlow empty document create failed')
      return doc
    }
    if (!data?.id) throw badRequest('RAGFlow empty document create failed')
    return data
  }

  /**
   * Add a manual chunk to a document.
   * RAGFlow: POST /api/v1/datasets/{dataset_id}/documents/{document_id}/chunks
   */
  async addChunk(
    datasetId: string,
    documentId: string,
    input: AddChunkInput
  ): Promise<RagflowChunk> {
    if (this.useMock()) {
      return this.mock.addChunk(datasetId, documentId, input)
    }
    const body: Record<string, unknown> = { content: input.content }
    if (input.importantKeywords?.length) {
      body.important_keywords = input.importantKeywords
    }
    if (input.questions?.length) {
      body.questions = input.questions
    }
    const data = await this.request<{ chunk?: RagflowChunk } | RagflowChunk>(
      'POST',
      `/api/v1/datasets/${datasetId}/documents/${documentId}/chunks`,
      { body }
    )
    const chunk =
      data && typeof data === 'object' && 'chunk' in data
        ? (data as { chunk?: RagflowChunk }).chunk
        : (data as RagflowChunk)
    if (!chunk?.id) throw badRequest('RAGFlow add chunk failed')
    return chunk
  }

  /**
   * Update a chunk (content / keywords / availability).
   * RAGFlow: PATCH /api/v1/datasets/{dataset_id}/documents/{document_id}/chunks/{chunk_id}
   */
  async updateChunk(
    datasetId: string,
    documentId: string,
    chunkId: string,
    input: UpdateChunkInput
  ): Promise<void> {
    if (this.useMock()) {
      this.mock.updateChunk(datasetId, documentId, chunkId, input)
      return
    }
    const body: Record<string, unknown> = {}
    if (input.content !== undefined) body.content = input.content
    if (input.importantKeywords !== undefined) {
      body.important_keywords = input.importantKeywords
    }
    if (input.questions !== undefined) body.questions = input.questions
    if (input.available !== undefined) body.available = input.available
    await this.request(
      'PATCH',
      `/api/v1/datasets/${datasetId}/documents/${documentId}/chunks/${chunkId}`,
      { body }
    )
  }

  /**
   * Delete chunks by id.
   * RAGFlow: DELETE /api/v1/datasets/{dataset_id}/documents/{document_id}/chunks
   * Body: { chunk_ids: string[] }
   */
  async deleteChunks(
    datasetId: string,
    documentId: string,
    chunkIds: string[]
  ): Promise<void> {
    if (this.useMock()) {
      this.mock.deleteChunks(datasetId, documentId, chunkIds)
      return
    }
    await this.request(
      'DELETE',
      `/api/v1/datasets/${datasetId}/documents/${documentId}/chunks`,
      { body: { chunk_ids: chunkIds } }
    )
  }

  async parseDocuments(datasetId: string, documentIds: string[]): Promise<void> {
    if (this.useMock()) {
      this.mock.parseDocuments(datasetId, documentIds)
      return
    }
    await this.request('POST', `/api/v1/datasets/${datasetId}/chunks`, {
      body: { document_ids: documentIds }
    })
  }

  /**
   * Stop parsing specified documents.
   * RAGFlow: DELETE /api/v1/datasets/{dataset_id}/chunks
   * Body: { document_ids: string[] }
   */
  async stopParseDocuments(datasetId: string, documentIds: string[]): Promise<void> {
    if (this.useMock()) {
      this.mock.stopParseDocuments(datasetId, documentIds)
      return
    }
    await this.request('DELETE', `/api/v1/datasets/${datasetId}/chunks`, {
      body: { document_ids: documentIds }
    })
  }

  async getDocument(datasetId: string, documentId: string): Promise<RagflowDocument | null> {
    if (this.useMock()) {
      return this.mock.getDocument(datasetId, documentId)
    }
    // List with id filter
    const data = await this.request<{ docs?: RagflowDocument[]; total?: number } | RagflowDocument[]>(
      'GET',
      `/api/v1/datasets/${datasetId}/documents?id=${encodeURIComponent(documentId)}&page=1&page_size=1`
    )
    if (Array.isArray(data)) return data[0] || null
    const docs = (data as { docs?: RagflowDocument[] }).docs || []
    return docs[0] || null
  }

  async deleteDocuments(datasetId: string, documentIds: string[]): Promise<void> {
    if (this.useMock()) {
      for (const id of documentIds) this.mock.deleteDocument(datasetId, id)
      return
    }
    await this.request('DELETE', `/api/v1/datasets/${datasetId}/documents`, {
      body: { ids: documentIds }
    })
  }

  /**
   * Download original document bytes from RAGFlow.
   * API: GET /api/v1/datasets/{dataset_id}/documents/{document_id}
   * Success returns raw file body; failure returns JSON { code, message }.
   */
  async downloadDocument(datasetId: string, documentId: string): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
    if (this.useMock()) {
      const file = this.mock.downloadDocument(datasetId, documentId)
      if (!file) throw badRequest('document file not found')
      return {
        buffer: file.buffer,
        contentType: guessContentType(file.filename),
        filename: file.filename
      }
    }

    const url = `${this.baseUrl()}/api/v1/datasets/${datasetId}/documents/${documentId}`
    const res = await fetch(url, {
      method: 'GET',
      headers: this.headers(false)
    })
    const contentType = res.headers.get('content-type') || ''
    const disposition = res.headers.get('content-disposition') || ''
    const filenameFromHeader = parseFilename(disposition)

    // RAGFlow returns JSON on error; binary/text on success.
    if (contentType.includes('application/json')) {
      const text = await res.text()
      let message = `RAGFlow download failed (${res.status})`
      try {
        const json = JSON.parse(text) as ApiEnvelope<unknown>
        if (json.message) message = json.message
        else if (json.code !== 0) message = `RAGFlow error code ${json.code}`
      } catch {
        message = text.slice(0, 200) || message
      }
      throw badRequest(message)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw badRequest(`RAGFlow download failed (${res.status}): ${text.slice(0, 200)}`)
    }

    const ab = await res.arrayBuffer()
    const buffer = Buffer.from(ab)
    const filename = filenameFromHeader || `document-${documentId}`
    return {
      buffer,
      contentType: contentType || guessContentType(filename),
      filename
    }
  }

  async listChunks(
    datasetId: string,
    documentId: string,
    opts: { page?: number; pageSize?: number; keywords?: string } = {}
  ): Promise<{ chunks: RagflowChunk[]; total: number }> {
    const page = opts.page || 1
    const pageSize = opts.pageSize || 20
    if (this.useMock()) {
      return this.mock.listChunks(datasetId, documentId, page, pageSize, opts.keywords)
    }
    const qs = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize)
    })
    if (opts.keywords) qs.set('keywords', opts.keywords)
    const data = await this.request<{ chunks: RagflowChunk[]; total: number }>(
      'GET',
      `/api/v1/datasets/${datasetId}/documents/${documentId}/chunks?${qs}`
    )
    return {
      chunks: data?.chunks || [],
      total: data?.total || 0
    }
  }

  async retrieve(input: RetrieveOptions): Promise<RetrieveHit[]> {
    const defaults = getRagRetrievalConfig()
    const page = Math.max(1, input.page ?? 1)
    const pageSize = Math.max(1, input.pageSize ?? defaults.pageSize)
    const topK = Math.max(pageSize, input.topK ?? defaults.topK)
    const similarityThreshold = input.similarityThreshold ?? defaults.similarityThreshold
    const vectorSimilarityWeight = input.vectorSimilarityWeight ?? defaults.vectorSimilarityWeight
    const rerankId = input.rerankId ?? defaults.rerankId
    const keyword = input.keyword === true
    const highlight = input.highlight === true

    if (this.useMock()) {
      return this.mock.retrieve(input.datasetIds, input.question, pageSize, {
        similarityThreshold,
        keyword,
        vectorSimilarityWeight,
        documentIds: input.documentIds
      })
    }

    // RAGFlow HTTP API: POST /api/v1/retrieval
    // dataset_ids and/or document_ids required; document_ids hard-filters chunks.
    const body: Record<string, unknown> = {
      question: input.question,
      dataset_ids: input.datasetIds,
      page,
      // Over-retrieve then let page_size trim; hybrid/rerank reorder inside RAGFlow.
      top_k: topK,
      page_size: pageSize,
      similarity_threshold: similarityThreshold,
      vector_similarity_weight: vectorSimilarityWeight,
      keyword,
      highlight
    }
    if (input.documentIds?.length) {
      body.document_ids = input.documentIds
    }
    if (rerankId) {
      body.rerank_id = rerankId
    }

    this.logger.debug(
      `retrieve q="${input.question.slice(0, 80)}" datasets=${input.datasetIds.length}` +
        `${input.documentIds?.length ? ` docs=${input.documentIds.length}` : ''}` +
        ` page=${page} top_k=${topK} page_size=${pageSize} thr=${similarityThreshold}` +
        ` v_weight=${vectorSimilarityWeight} keyword=${keyword} highlight=${highlight}` +
        `${rerankId ? ` rerank=${rerankId}` : ''}`
    )

    const data = await this.request<{ chunks?: Array<Record<string, unknown>> }>('POST', '/api/v1/retrieval', { body })
    const chunks = data?.chunks || []
    return chunks.map(c => this.mapRetrievalChunk(c))
  }

  /**
   * Keyword / exact-term search via RAGFlow POST /api/v1/retrieval.
   *
   * Uses pure term ranking (vector_similarity_weight=0), large top_k,
   * and highlight=true — no client-side keyword filter.
   */
  async keywordSearch(input: KeywordSearchOptions): Promise<RetrieveHit[]> {
    const defaults = getRagRetrievalConfig()
    const pageSize = Math.max(1, input.pageSize ?? defaults.pageSize)
    const topK = Math.max(pageSize, input.topK ?? defaults.keywordTopK)
    const pattern = input.question.trim()
    if (!pattern) return []
    if (!input.datasetIds.length) return []

    // page_size = evidence page (RAG_PAGE_SIZE). RAGFlow max is 100.
    const fetchPageSize = Math.min(RAGFLOW_RETRIEVAL_MAX_PAGE_SIZE, pageSize)

    return this.retrieve({
      datasetIds: input.datasetIds,
      question: pattern,
      page: 1,
      pageSize: fetchPageSize,
      topK,
      similarityThreshold: defaults.keywordSimilarityThreshold,
      vectorSimilarityWeight: defaults.keywordVectorWeight,
      // Match RAGFlow retrieval keyword-style: term rank via v_weight=0, not keyword flag.
      keyword: false,
      highlight: true,
      rerankId: undefined,
      documentIds: input.documentIds
    })
  }

  private mapRetrievalChunk(c: Record<string, unknown>): RetrieveHit {
    const rawPositions = c.positions ?? c.position
    let positions: RetrieveHit['positions']
    if (Array.isArray(rawPositions)) {
      positions = rawPositions as RetrieveHit['positions']
    }
    const score = typeof c.similarity === 'number' ? c.similarity : typeof c.score === 'number' ? c.score : undefined
    const termSimilarity = typeof c.term_similarity === 'number' ? c.term_similarity : undefined
    const vectorSimilarity = typeof c.vector_similarity === 'number' ? c.vector_similarity : undefined
    const highlight = typeof c.highlight === 'string' && c.highlight ? c.highlight : undefined
    return {
      id: String(c.id || c.chunk_id || ''),
      content: String(c.content || c.content_with_weight || ''),
      documentId: c.document_id ? String(c.document_id) : undefined,
      documentName: c.document_keyword ? String(c.document_keyword) : c.docnm_kwd ? String(c.docnm_kwd) : undefined,
      datasetId: c.dataset_id ? String(c.dataset_id) : undefined,
      score,
      termSimilarity,
      vectorSimilarity,
      highlight,
      positions
    }
  }

  mapRunToStatus(run: string | number | undefined): 'unstart' | 'running' | 'done' | 'fail' {
    const v = String(run ?? 'UNSTART').toUpperCase()
    if (v === '0' || v === 'UNSTART' || v === 'UNSTARTED') return 'unstart'
    if (v === '1' || v === 'RUNNING' || v === '2' || v.includes('RUN')) {
      // RAGFlow sometimes uses numeric codes; treat in-progress codes as running
      if (v === '3' || v === 'DONE' || v === 'SUCCESS' || v === '4') return 'done'
      if (v === 'FAIL' || v === 'FAILED' || v === '5') return 'fail'
      if (v === '1' || v === '2' || v.includes('RUN') || v === 'RUNNING') return 'running'
    }
    if (v === '3' || v === 'DONE' || v === 'SUCCESS' || (v === 'CANCEL' && false)) return 'done'
    if (v.includes('DONE') || v.includes('SUCCESS') || v === '3') return 'done'
    if (v.includes('FAIL') || v === '4' || v === '5') return 'fail'
    if (v.includes('RUN')) return 'running'
    return 'unstart'
  }
}

function parseFilename(contentDisposition: string): string | undefined {
  if (!contentDisposition) return undefined
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition)
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ''))
    } catch {
      return utf8[1].trim().replace(/^"|"$/g, '')
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(contentDisposition)
  return plain?.[1]?.trim() || undefined
}

function guessContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    markdown: 'text/markdown; charset=utf-8',
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    json: 'application/json',
    csv: 'text/csv; charset=utf-8',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml'
  }
  return map[ext] || 'application/octet-stream'
}
