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
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
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

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  chunkMethod: string;
  parserConfig?: Record<string, unknown>;
  documentCount?: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateKnowledgeBaseBody = {
  name: string;
  description?: string;
  chunkMethod?: string;
  parserConfig?: Record<string, unknown>;
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
  createdAt: string;
  updatedAt: string;
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
  bootstrap: () =>
    apiFetch<{ allowRegister: boolean }>('/api/auth/bootstrap'),
  me: () =>
    apiFetch<{ user: User; csrfToken: string }>('/api/auth/me'),
  login: (username: string, password: string) =>
    apiFetch<{ user: User; csrfToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  register: (username: string, password: string) =>
    apiFetch<{ user: User; csrfToken: string }>('/api/auth/register', {
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
  remove: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/knowledge-bases/${id}`, { method: 'DELETE' }),
};

export const docApi = {
  list: (kbId: string) =>
    apiFetch<{ items: DocumentItem[] }>(`/api/knowledge-bases/${kbId}/documents`),
  upload: async (kbId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiFetch<DocumentItem>(`/api/knowledge-bases/${kbId}/documents`, {
      method: 'POST',
      body: form,
    });
  },
  parse: (kbId: string, docId: string) =>
    apiFetch<DocumentItem>(
      `/api/knowledge-bases/${kbId}/documents/${docId}/parse`,
      { method: 'POST' },
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
    opts?: { knowledgeBaseIds?: string[] },
  ): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
    const body: { content: string; knowledgeBaseIds?: string[] } = { content };
    if (opts?.knowledgeBaseIds?.length) {
      body.knowledgeBaseIds = opts.knowledgeBaseIds;
    }
    const res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCsrfToken(),
      },
      body: JSON.stringify(body),
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
    while (true) {
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
  },
};
