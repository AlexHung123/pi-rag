const API_BASE = '';

/** In-memory CSRF from login/me body — more reliable than document.cookie alone. */
let memoryCsrfToken = '';

export function setCsrfToken(token: string | undefined | null) {
  memoryCsrfToken = (token || '').trim();
}

function getCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}

export function getCsrfToken(): string {
  return memoryCsrfToken || getCookie('csb_kb_csrf');
}

/**
 * CSRF must be sent as a header (server no longer accepts cookie-only).
 * If memory/cookie is empty, refresh once via GET /api/auth/me.
 */
async function requireCsrfToken(): Promise<string> {
  let csrf = getCsrfToken();
  if (csrf) return csrf;
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' });
    if (res.ok) {
      const data = (await res.json()) as { csrfToken?: string };
      if (data.csrfToken) {
        setCsrfToken(data.csrfToken);
        csrf = data.csrfToken;
      }
    }
  } catch {
    // fall through to throw below
  }
  if (!csrf) {
    throw new Error('Missing CSRF token; please reload or log in again');
  }
  return csrf;
}

function errorMessageFromBody(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const msg = (data as { message?: unknown }).message;
  if (typeof msg === 'string' && msg.trim()) return msg;
  if (Array.isArray(msg) && msg.length) return msg.map(String).join('; ');
  return fallback;
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    throw new Error(errorMessageFromBody(data, res.statusText || `HTTP ${res.status}`));
  }
  // Capture csrf from any auth-shaped response
  if (data && typeof data === 'object' && 'csrfToken' in data) {
    const t = (data as { csrfToken?: string }).csrfToken;
    if (t) setCsrfToken(t);
  }
  return data as T;
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const method = (init.method || 'GET').toUpperCase();
  // login: no session yet. logout: server does not require CSRF.
  const skipCsrf =
    path === '/api/auth/login' || path === '/api/auth/logout';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !skipCsrf) {
    headers.set('X-CSRF-Token', await requireCsrfToken());
  } else if (path === '/api/auth/logout') {
    const csrf = getCsrfToken();
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  return parseJson<T>(res);
}

export type User = { id: string; username: string; role: string };

/** Total document storage for the current user (sum of sizeBytes vs quota). */
export type StorageUsage = {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  usageRatio: number;
};

export type KnowledgeBaseVisibility = 'private' | 'public';
export type KnowledgeBaseRole = 'owner' | 'viewer' | 'editor';

export type AdminDataset = {
  id: string;
  name: string;
  description: string;
  chunkMethod: string;
  visibility?: KnowledgeBaseVisibility;
  documentCount: number;
  chunkCount: number;
  ownerUserId: string;
  ownerUsername: string;
  createdAt: string;
  updatedAt: string;
};

export type AdminDocument = {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName?: string;
  ownerUserId: string;
  ownerUsername?: string;
  name: string;
  sizeBytes: number;
  status: 'unstart' | 'running' | 'done' | 'fail';
  progress: number;
  progressMsg?: string | null;
  chunkCount: number;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminTaskStats = {
  total: number;
  running: number;
  unstart: number;
  done: number;
  fail: number;
  cancel: number;
};

export type AdminTranscriptionJob = {
  id: string;
  documentId: string;
  documentName: string | null;
  knowledgeBaseId: string;
  ownerUserId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: string;
  progress: number;
  progressMsg: string | null;
  language: string | null;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminTranscriptionJobStats = {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
};

export type AdminUser = {
  id: string;
  username: string;
  role: string;
  disabled: boolean;
  datasetCount: number;
  documentCount: number;
  conversationCount: number;
  storageQuotaBytes: number;
  storageUsedBytes: number;
  storageRemainingBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminAgentSession = {
  conversationId: string;
  conversationTitle: string;
  userId: string;
  ownerUsername: string;
  busy: boolean;
  isStreaming: boolean;
  messageCount: number;
  dbMessageCount: number | null;
  modelId: string | null;
  modelProvider: string | null;
  lastUsedAt: string;
  conversationUpdatedAt: string | null;
};

export type AdminAgentSessionStats = {
  size: number;
  maxSessions: number;
  busy: number;
  idle: number;
  ttlMs: number;
};

export type Paged<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  chunkMethod: string;
  parserConfig?: Record<string, unknown>;
  visibility: KnowledgeBaseVisibility;
  ownerUserId: string;
  ownerUsername?: string;
  isOwner: boolean;
  myRole?: KnowledgeBaseRole | null;
  documentCount?: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateKnowledgeBaseBody = {
  name: string;
  description?: string;
  chunkMethod?: string;
  parserConfig?: Record<string, unknown>;
  visibility?: KnowledgeBaseVisibility;
};

export type UpdateKnowledgeBaseBody = {
  visibility?: KnowledgeBaseVisibility;
};

export type KnowledgeBaseMemberRole = 'viewer' | 'editor';

export type KnowledgeBaseMember = {
  id: string;
  userId: string;
  username: string;
  role: KnowledgeBaseMemberRole;
  createdAt: string;
  updatedAt: string;
};

export type DocumentSourceType = 'file' | 'audio';

export type TranscriptionJobSummary = {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: string;
  progress: number;
  progressMsg: string | null;
  errorMessage: string | null;
};

export type DocumentItem = {
  id: string;
  knowledgeBaseId: string;
  name: string;
  sizeBytes: number;
  status: 'unstart' | 'running' | 'done' | 'fail';
  progress: number;
  progressMsg?: string | null;
  chunkCount: number;
  errorMessage?: string | null;
  sourceType?: DocumentSourceType;
  /** MIME of original media (audio pipeline), e.g. video/mp4 */
  mediaContentType?: string | null;
  /** Extension of original media file (audio pipeline); display name often omits it */
  mediaExtension?: string | null;
  durationSeconds?: number | null;
  transcriptLanguage?: string | null;
  ragflowDocumentId?: string | null;
  /** Audio: local transcript ready, not yet in RAGFlow */
  transcriptReady?: boolean;
  transcription?: TranscriptionJobSummary | null;
  createdAt: string;
  updatedAt: string;
};

export type TranscriptPreview = {
  documentId: string;
  name: string;
  language: string | null;
  durationSeconds: number | null;
  ragflowDocumentId: string | null;
  markdown: string;
};

/** RAGFlow position box: [pageNumber, x1, x2, y1, y2] in PDF page space */
export type ChunkPosition = number[];

export type ChunkItem = {
  id: string;
  content: string;
  available?: boolean;
  positions?: ChunkPosition[];
  imageId?: string;
};

export type Conversation = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CitationSource = {
  id: string;
  content: string;
  documentName?: string;
  documentId?: string;
  appDocumentId?: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  score?: number;
  index: number;
  evidenceLabel: string;
  positions?: number[][];
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt: string;
  metadata?: {
    sources?: CitationSource[];
    knowledgeBaseIds?: string[];
    [key: string]: unknown;
  } | null;
  sources?: CitationSource[];
};

export const authApi = {
  bootstrap: () => apiFetch<{ authEnabled: boolean }>('/api/auth/bootstrap'),
  me: () =>
    apiFetch<{ user: User; csrfToken: string }>('/api/auth/me'),
  storage: () => apiFetch<StorageUsage>('/api/auth/me/storage'),
  login: (username: string, password: string) =>
    apiFetch<{ user: User; csrfToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: async () => {
    const res = await apiFetch<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
    });
    setCsrfToken('');
    return res;
  },
};

export const kbApi = {
  list: () => apiFetch<{ items: KnowledgeBase[] }>('/api/knowledge-bases'),
  create: (body: CreateKnowledgeBaseBody) =>
    apiFetch<KnowledgeBase>('/api/knowledge-bases', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (id: string, body: UpdateKnowledgeBaseBody) =>
    apiFetch<KnowledgeBase>(`/api/knowledge-bases/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/knowledge-bases/${id}`, { method: 'DELETE' }),
  listMembers: (kbId: string) =>
    apiFetch<{ items: KnowledgeBaseMember[] }>(`/api/knowledge-bases/${kbId}/members`),
  listShareCandidates: (kbId: string) =>
    apiFetch<{ items: Array<{ id: string; username: string }> }>(
      `/api/knowledge-bases/${kbId}/share-candidates`,
    ),
  addMember: (kbId: string, body: { username: string; role?: KnowledgeBaseMemberRole }) =>
    apiFetch<KnowledgeBaseMember>(`/api/knowledge-bases/${kbId}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateMember: (kbId: string, userId: string, body: { role: KnowledgeBaseMemberRole }) =>
    apiFetch<KnowledgeBaseMember>(`/api/knowledge-bases/${kbId}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  removeMember: (kbId: string, userId: string) =>
    apiFetch<{ ok: boolean }>(`/api/knowledge-bases/${kbId}/members/${userId}`, {
      method: 'DELETE',
    }),
};

export const docApi = {
  list: (kbId: string) =>
    apiFetch<{ items: DocumentItem[] }>(`/api/knowledge-bases/${kbId}/documents`),
  upload: async (kbId: string, file: File, opts?: { language?: string }) => {
    const form = new FormData();
    form.append('file', file);
    if (opts?.language) form.append('language', opts.language);
    return apiFetch<DocumentItem>(`/api/knowledge-bases/${kbId}/documents`, {
      method: 'POST',
      body: form,
    });
  },
  cancelTranscription: (kbId: string, docId: string) =>
    apiFetch<DocumentItem>(
      `/api/knowledge-bases/${kbId}/documents/${docId}/cancel-transcription`,
      { method: 'POST' },
    ),
  retryTranscription: (kbId: string, docId: string) =>
    apiFetch<DocumentItem>(
      `/api/knowledge-bases/${kbId}/documents/${docId}/retry-transcription`,
      { method: 'POST' },
    ),
  getTranscript: (kbId: string, docId: string) =>
    apiFetch<TranscriptPreview>(
      `/api/knowledge-bases/${kbId}/documents/${docId}/transcript`,
    ),
  saveTranscript: (kbId: string, docId: string, markdown: string) =>
    apiFetch<DocumentItem>(
      `/api/knowledge-bases/${kbId}/documents/${docId}/transcript`,
      { method: 'POST', body: JSON.stringify({ markdown }) },
    ),
  /** Push transcript to RAGFlow (+ parse by default). */
  ingestTranscript: (
    kbId: string,
    docId: string,
    opts?: { parse?: boolean; markdown?: string },
  ) =>
    apiFetch<DocumentItem>(
      `/api/knowledge-bases/${kbId}/documents/${docId}/ingest-transcript`,
      { method: 'POST', body: JSON.stringify(opts || {}) },
    ),
  parse: (kbId: string, docId: string) =>
    apiFetch<DocumentItem>(
      `/api/knowledge-bases/${kbId}/documents/${docId}/parse`,
      { method: 'POST' },
    ),
  /** Parse many documents in one request (skips already-running). */
  batchParse: (kbId: string, documentIds: string[]) =>
    apiFetch<{ ok: boolean; count: number; skipped: number; items: DocumentItem[] }>(
      `/api/knowledge-bases/${kbId}/documents/batch-parse`,
      { method: 'POST', body: JSON.stringify({ documentIds }) },
    ),
  stopParse: (kbId: string, docId: string) =>
    apiFetch<DocumentItem>(
      `/api/knowledge-bases/${kbId}/documents/${docId}/stop-parse`,
      { method: 'POST' },
    ),
  /** Stop parse for many documents in one request (only running). */
  batchStopParse: (kbId: string, documentIds: string[]) =>
    apiFetch<{ ok: boolean; count: number; skipped: number; items: DocumentItem[] }>(
      `/api/knowledge-bases/${kbId}/documents/batch-stop-parse`,
      { method: 'POST', body: JSON.stringify({ documentIds }) },
    ),
  preview: (kbId: string, docId: string) =>
    apiFetch<{
      document: DocumentItem;
      chunks: ChunkItem[];
      totalChunks: number;
    }>(`/api/knowledge-bases/${kbId}/documents/${docId}/preview`),
  chunks: (
    kbId: string,
    docId: string,
    opts?: { page?: number; pageSize?: number; keywords?: string },
  ) => {
    const qs = new URLSearchParams();
    if (opts?.page) qs.set('page', String(opts.page));
    if (opts?.pageSize) qs.set('pageSize', String(opts.pageSize));
    if (opts?.keywords) qs.set('keywords', opts.keywords);
    const q = qs.toString();
    return apiFetch<{
      document: DocumentItem;
      chunks: ChunkItem[];
      total: number;
      page: number;
      pageSize: number;
    }>(
      `/api/knowledge-bases/${kbId}/documents/${docId}/chunks${q ? `?${q}` : ''}`,
    );
  },
  /** Blob URL for inline file preview (revoke when done). */
  fetchFileBlob: async (kbId: string, docId: string): Promise<{ blob: Blob; objectUrl: string }> => {
    const res = await fetch(
      `${API_BASE}/api/knowledge-bases/${kbId}/documents/${docId}/file`,
      { credentials: 'include' },
    );
    if (!res.ok) {
      const text = await res.text();
      let message = text || `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { message?: string };
        if (j.message) message = j.message;
      } catch {
        // keep text
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    return { blob, objectUrl: URL.createObjectURL(blob) };
  },
  remove: (kbId: string, docId: string) =>
    apiFetch<{ ok: boolean }>(
      `/api/knowledge-bases/${kbId}/documents/${docId}`,
      { method: 'DELETE' },
    ),
};

function qs(params: Record<string, string | number | undefined | null>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const adminApi = {
  listDatasets: (params?: {
    page?: number;
    pageSize?: number;
    name?: string;
    owner?: string;
    chunkMethod?: string;
  }) =>
    apiFetch<Paged<AdminDataset>>(
      `/api/admin/datasets${qs(params || {})}`,
    ),
  batchDeleteDatasets: (ids: string[]) =>
    apiFetch<{ ok: boolean; deleted: number }>(
      '/api/admin/datasets/batch-delete',
      { method: 'POST', body: JSON.stringify({ ids }) },
    ),
  listDocuments: (
    kbId: string,
    params?: {
      page?: number;
      pageSize?: number;
      keywords?: string;
      status?: string;
    },
  ) =>
    apiFetch<Paged<AdminDocument>>(
      `/api/admin/datasets/${kbId}/documents${qs(params || {})}`,
    ),
  uploadDocument: async (kbId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiFetch<AdminDocument>(
      `/api/admin/datasets/${kbId}/documents/upload`,
      { method: 'POST', body: form },
    );
  },
  parseDocuments: (kbId: string, documentIds: string[]) =>
    apiFetch<{ ok: boolean; count: number }>(
      `/api/admin/datasets/${kbId}/documents/parse`,
      { method: 'POST', body: JSON.stringify({ documentIds }) },
    ),
  stopParseDocuments: (kbId: string, documentIds: string[]) =>
    apiFetch<{ ok: boolean; count: number }>(
      `/api/admin/datasets/${kbId}/documents/stop-parse`,
      { method: 'POST', body: JSON.stringify({ documentIds }) },
    ),
  batchDeleteDocuments: (kbId: string, ids: string[]) =>
    apiFetch<{ ok: boolean; deleted: number }>(
      `/api/admin/datasets/${kbId}/documents/batch-delete`,
      { method: 'POST', body: JSON.stringify({ ids }) },
    ),
  listTasks: (params?: {
    page?: number;
    pageSize?: number;
    docName?: string;
    datasetName?: string;
    owner?: string;
    status?: string;
  }) => apiFetch<Paged<AdminDocument>>(`/api/admin/tasks${qs(params || {})}`),
  taskStats: () => apiFetch<AdminTaskStats>('/api/admin/tasks/stats'),
  batchParseTasks: (
    tasks: Array<{ knowledgeBaseId: string; documentIds: string[] }>,
  ) =>
    apiFetch<{ ok: boolean; count: number }>(
      '/api/admin/tasks/batch-parse',
      { method: 'POST', body: JSON.stringify({ tasks }) },
    ),
  batchStopTasks: (
    tasks: Array<{ knowledgeBaseId: string; documentIds: string[] }>,
  ) =>
    apiFetch<{ ok: boolean; count: number }>(
      '/api/admin/tasks/batch-stop',
      { method: 'POST', body: JSON.stringify({ tasks }) },
    ),
  retryFailedTasks: () =>
    apiFetch<{ ok: boolean; retried: number }>(
      '/api/admin/tasks/retry-failed',
      { method: 'POST', body: JSON.stringify({}) },
    ),
  listTranscriptionJobs: (params?: {
    page?: number;
    pageSize?: number;
    status?: string;
  }) =>
    apiFetch<Paged<AdminTranscriptionJob>>(
      `/api/admin/transcription-jobs${qs(params || {})}`,
    ),
  transcriptionJobStats: () =>
    apiFetch<AdminTranscriptionJobStats>('/api/admin/transcription-jobs/stats'),
  listUsers: (params?: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    status?: string;
  }) => apiFetch<Paged<AdminUser>>(`/api/admin/users${qs(params || {})}`),
  createUser: (body: {
    username: string;
    password: string;
    role?: string;
    storageQuotaBytes?: number;
  }) =>
    apiFetch<AdminUser>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  setUserStatus: (id: string, disabled: boolean) =>
    apiFetch<{ id: string; username: string; role: string; disabled: boolean }>(
      `/api/admin/users/${id}/status`,
      { method: 'PATCH', body: JSON.stringify({ disabled }) },
    ),
  setUserRole: (id: string, role: string) =>
    apiFetch<{ id: string; username: string; role: string; disabled: boolean }>(
      `/api/admin/users/${id}/role`,
      { method: 'PATCH', body: JSON.stringify({ role }) },
    ),
  setUserStorageQuota: (id: string, storageQuotaBytes: number) =>
    apiFetch<{
      id: string;
      username: string;
      role: string;
      disabled: boolean;
      storageQuotaBytes: number;
      storageUsedBytes: number;
      storageRemainingBytes: number;
    }>(`/api/admin/users/${id}/storage-quota`, {
      method: 'PATCH',
      body: JSON.stringify({ storageQuotaBytes }),
    }),
  setUserPassword: (id: string, password: string) =>
    apiFetch<{ ok: boolean }>(`/api/admin/users/${id}/password`, {
      method: 'PATCH',
      body: JSON.stringify({ password }),
    }),
  batchDeleteUsers: (ids: string[]) =>
    apiFetch<{ ok: boolean; deleted: number }>(
      '/api/admin/users/batch-delete',
      { method: 'POST', body: JSON.stringify({ ids }) },
    ),
  listAgentSessions: (params?: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    status?: string;
  }) =>
    apiFetch<
      Paged<AdminAgentSession> & { stats: AdminAgentSessionStats }
    >(`/api/admin/agent-sessions${qs(params || {})}`),
  agentSessionStats: () =>
    apiFetch<AdminAgentSessionStats>('/api/admin/agent-sessions/stats'),
  disposeAgentSessions: (conversationIds: string[]) =>
    apiFetch<{ ok: boolean; disposed: number }>(
      '/api/admin/agent-sessions/batch-dispose',
      { method: 'POST', body: JSON.stringify({ conversationIds }) },
    ),
};

/** key = id (API modelId), value = name (UI label) */
export type ChatModelOption = { id: string; name: string };

export type ChatModelsResponse = {
  defaultModelId: string;
  models: ChatModelOption[];
};

export const modelsApi = {
  list: () => apiFetch<ChatModelsResponse>('/api/models'),
};

export const chatApi = {
  list: () => apiFetch<{ items: Conversation[] }>('/api/conversations'),
  create: (title?: string) =>
    apiFetch<Conversation & { messages: ChatMessage[] }>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  get: (id: string) =>
    apiFetch<Conversation & { messages: ChatMessage[] }>(
      `/api/conversations/${id}`,
    ),
  remove: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),
  streamMessage: async function* (
    conversationId: string,
    content: string,
    opts?: {
      knowledgeBaseIds?: string[];
      modelId?: string;
      signal?: AbortSignal;
    },
  ): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
    const body: {
      content: string;
      knowledgeBaseIds?: string[];
      modelId?: string;
    } = { content };
    if (opts?.knowledgeBaseIds?.length) {
      body.knowledgeBaseIds = opts.knowledgeBaseIds;
    }
    if (opts?.modelId?.trim()) {
      body.modelId = opts.modelId.trim();
    }
    const signal = opts?.signal;
    const res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': await requireCsrfToken(),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      let message = text || `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { message?: string };
        if (j.message) message = j.message;
      } catch {
        // keep text
      }
      throw new Error(message);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort);
    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const lines = part.split('\n');
          let event = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            yield { event, data: JSON.parse(data) as Record<string, unknown> };
          } catch {
            yield { event, data: { raw: data } };
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  },
};
