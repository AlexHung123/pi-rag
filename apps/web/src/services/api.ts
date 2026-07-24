const API_BASE = '';

function getCookie(name: string): string {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}

export function getCsrfToken(): string {
  return getCookie('pi_rag_csrf');
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
    const msg =
      typeof data === 'object' && data && 'message' in data
        ? String((data as { message: unknown }).message)
        : res.statusText;
    throw new Error(msg || `HTTP ${res.status}`);
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
  documentCount?: number;
  createdAt: string;
  updatedAt: string;
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

export type ChunkItem = {
  id: string;
  content: string;
  available?: boolean;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt: string;
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
  logout: () =>
    apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
};

export const kbApi = {
  list: () => apiFetch<{ items: KnowledgeBase[] }>('/api/knowledge-bases'),
  create: (body: { name: string; description?: string; chunkMethod?: string }) =>
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
  ): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
    const res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCsrfToken(),
      },
      body: JSON.stringify({ content }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
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
