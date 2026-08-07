import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './contexts/AuthContext';
import Login from './components/Login';
import Markdown from './components/Markdown';
import KnowledgePanel from './components/KnowledgePanel';
import MemoryPanel from './components/MemoryPanel';
import AppSidebar, { type WorkspaceView } from './components/AppSidebar';
import SourceReferences from './components/SourceReferences';
import DocumentLocateDrawer from './components/DocumentLocateDrawer';
import FileTypeIcon from './components/FileTypeIcon';
import AgentProcessPanel, {
  applyAgentStatus,
  applyProcessDone,
  applyTextStarted,
  applyToolEnd,
  applyToolStart,
  createInitialProcess,
  type AgentProcessState,
} from './components/AgentProcessPanel';
import AdminDatasetsPanel from './components/admin/AdminDatasetsPanel';
import AdminDocumentsPanel from './components/admin/AdminDocumentsPanel';
import AdminTasksPanel from './components/admin/AdminTasksPanel';
import AdminUsersPanel from './components/admin/AdminUsersPanel';
import AdminAgentSessionsPanel from './components/admin/AdminAgentSessionsPanel';
import {
  chatApi,
  docApi,
  kbApi,
  modelsApi,
  type ChatMessage,
  type CitationSource,
  type Conversation,
  type DocumentItem,
  type KnowledgeBase,
} from './services/api';
import {
  buildDocMentionText,
  extractAtQuery,
  filterDocAtCandidates,
  type AtQueryMatch,
  type DocAtCandidate,
} from './utils/docAtMention';

const DOC_CHIP_VISIBLE_MAX = 6;

function sourcesFromMessage(m: ChatMessage): CitationSource[] {
  if (Array.isArray(m.sources) && m.sources.length) return m.sources;
  const meta = m.metadata;
  if (meta && Array.isArray(meta.sources)) return meta.sources as CitationSource[];
  return [];
}

export default function App() {
  const { user, loading, logout } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  /**
   * Conversation id currently receiving an SSE stream (null if idle).
   * Stop / tool panel / composer lock apply only when this matches activeId —
   * switching chats must not steal the streaming UI into a different thread.
   */
  const [streamingConvId, setStreamingConvId] = useState<string | null>(null);
  /** Live + last-turn pi-agent process panel (one overlay per reply). */
  const [agentProcess, setAgentProcess] = useState<AgentProcessState | null>(
    null,
  );
  const [workspace, setWorkspace] = useState<WorkspaceView>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth > 768,
  );
  const [error, setError] = useState('');
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [expandedKbIds, setExpandedKbIds] = useState<string[]>([]);
  const [kbDocCache, setKbDocCache] = useState<Record<string, DocumentItem[]>>(
    {},
  );
  const [kbDocsLoading, setKbDocsLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [availableModels, setAvailableModels] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [defaultModelId, setDefaultModelId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [locateSource, setLocateSource] = useState<CitationSource | null>(null);
  const [adminDataset, setAdminDataset] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** Monotonic id so slower / out-of-order list responses cannot wipe newer state. */
  const listRequestIdRef = useRef(0);
  /** True while any conversation has an in-flight stream (for list-refresh guards). */
  const sendingRef = useRef(false);
  /** In-flight chat SSE; Stop aborts this controller. */
  const abortRef = useRef<AbortController | null>(null);
  /** Mirrors activeId for stream handlers (avoid stale closure / cross-chat writes). */
  const activeIdRef = useRef<string | null>(null);
  /** Mirrors messages so send() can seed inflight before React flushes setState. */
  const messagesRef = useRef<ChatMessage[]>([]);
  const streamingConvIdRef = useRef<string | null>(null);
  /**
   * Live messages + process panel for the streaming conversation.
   * Survives openConversation / newChat so switching away does not drop the panel
   * or let SSE updates rewrite another thread's messages.
   */
  const inflightRef = useRef<
    Map<
      string,
      { messages: ChatMessage[]; agentProcess: AgentProcessState | null }
    >
  >(new Map());

  const selectConversation = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  // Keep messagesRef in sync for synchronous inflight seeding inside send().
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /** Patch live stream cache; push to React state only when that chat is visible. */
  const patchInflight = useCallback(
    (
      convId: string,
      patch: (prev: {
        messages: ChatMessage[];
        agentProcess: AgentProcessState | null;
      }) => {
        messages: ChatMessage[];
        agentProcess: AgentProcessState | null;
      },
    ) => {
      const prev = inflightRef.current.get(convId) ?? {
        messages: [],
        agentProcess: null,
      };
      const next = patch(prev);
      inflightRef.current.set(convId, next);
      if (activeIdRef.current === convId) {
        messagesRef.current = next.messages;
        setMessages(next.messages);
        setAgentProcess(next.agentProcess);
      }
    },
    [],
  );

  const refreshConversations = useCallback(async () => {
    const reqId = ++listRequestIdRef.current;
    const res = await chatApi.list();
    const items = Array.isArray(res.items) ? res.items : [];
    // Ignore stale responses (e.g. initial load finishing after a create+list).
    if (reqId !== listRequestIdRef.current) return items;
    setConversations(items);
    // Drop selection if the conversation no longer exists (deleted elsewhere, DB reset).
    // Skip while a send is in flight so we don't clear a just-created id mid-stream.
    if (!sendingRef.current) {
      setActiveId((current) => {
        if (current && !items.some((c) => c.id === current)) {
          activeIdRef.current = null;
          // Defer message clear to avoid setState-during-setState.
          Promise.resolve().then(() => {
            setMessages((msgs) => (msgs.length ? [] : msgs));
            setAgentProcess(null);
          });
          return null;
        }
        return current;
      });
    }
    return items;
  }, []);

  const refreshKnowledgeBases = useCallback(async () => {
    const res = await kbApi.list();
    setKnowledgeBases(res.items);
    return res.items;
  }, []);

  const refreshModels = useCallback(async () => {
    const res = await modelsApi.list();
    const models = (Array.isArray(res.models) ? res.models : [])
      .map((m) => {
        const id = String(m?.id || '').trim();
        if (!id) return null;
        const name = String(m?.name || '').trim() || id;
        return { id, name };
      })
      .filter((m): m is { id: string; name: string } => m != null);
    const defaultId = (res.defaultModelId || models[0]?.id || '').trim();
    setAvailableModels(models);
    setDefaultModelId(defaultId);
    setSelectedModelId(defaultId);
    return res;
  }, []);

  // App stays mounted across logout/login, so session UI must be wiped when identity
  // changes — otherwise the previous account's conversation list flashes briefly.
  const userId = user?.id ?? null;
  useLayoutEffect(() => {
    listRequestIdRef.current += 1;
    setConversations([]);
    activeIdRef.current = null;
    setActiveId(null);
    setMessages([]);
    setInput('');
    setError('');
    setAgentProcess(null);
    setKnowledgeBases([]);
    setSelectedKbIds([]);
    setSelectedDocIds([]);
    setExpandedKbIds([]);
    setKbDocCache({});
    setKbDocsLoading({});
    setModelPickerOpen(false);
    setAvailableModels([]);
    setDefaultModelId('');
    setSelectedModelId('');
    setLocateSource(null);
    setAdminDataset(null);
    setWorkspace('chat');
    streamingConvIdRef.current = null;
    setStreamingConvId(null);
    sendingRef.current = false;
    inflightRef.current.clear();
    abortRef.current?.abort();
    abortRef.current = null;
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    refreshConversations().catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
    refreshKnowledgeBases().catch(() => {
      /* non-blocking for chat */
    });
    refreshModels().catch(() => {
      /* non-blocking: omit modelId on send → server default */
    });
  }, [userId, refreshConversations, refreshKnowledgeBases, refreshModels]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingConvId, agentProcess?.steps.length, agentProcess?.status]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (modelPickerOpen && !modelPickerRef.current?.contains(target)) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [modelPickerOpen]);

  /**
   * Resolve a conversation id that exists for this user.
   * Recovers from stale activeId (deleted chat, wiped list race, etc.).
   */
  const ensureConversationId = async (
    preferredId: string | null,
  ): Promise<string> => {
    if (preferredId) {
      if (conversations.some((c) => c.id === preferredId)) {
        return preferredId;
      }
      try {
        await chatApi.get(preferredId);
        return preferredId;
      } catch {
        // Stale or not owned — drop selection; create a fresh conversation below.
        selectConversation(null);
        setMessages([]);
        setAgentProcess(null);
      }
    }
    const c = await chatApi.create();
    selectConversation(c.id);
    await refreshConversations();
    return c.id;
  };

  const openConversation = async (id: string) => {
    setError('');
    setWorkspace('chat');
    // Restore live stream UI if this thread is still generating in the background.
    const live = inflightRef.current.get(id);
    if (live && streamingConvIdRef.current === id) {
      selectConversation(id);
      setMessages(live.messages);
      setAgentProcess(live.agentProcess);
      return;
    }
    selectConversation(id);
    setAgentProcess(null);
    try {
      const detail = await chatApi.get(id);
      // User may have switched away (or stream started) while the fetch was in flight.
      if (activeIdRef.current !== id) return;
      const liveAfter = inflightRef.current.get(id);
      if (liveAfter && streamingConvIdRef.current === id) {
        setMessages(liveAfter.messages);
        setAgentProcess(liveAfter.agentProcess);
        return;
      }
      setMessages(
        (detail.messages as ChatMessage[]).map((m) => ({
          ...m,
          sources: sourcesFromMessage(m),
        })),
      );
    } catch (e) {
      if (activeIdRef.current !== id) return;
      selectConversation(null);
      setMessages([]);
      setAgentProcess(null);
      setError(e instanceof Error ? e.message : String(e));
      await refreshConversations().catch(() => undefined);
    }
  };

  const newChat = async () => {
    try {
      setError('');
      // Do not abort or clear another chat's in-flight stream / process panel.
      const c = await chatApi.create();
      selectConversation(c.id);
      setMessages([]);
      setAgentProcess(null);
      setWorkspace('chat');
      if (!sidebarOpen) setSidebarOpen(true);
      await refreshConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteChat = async (id: string) => {
    try {
      if (streamingConvIdRef.current === id) {
        abortRef.current?.abort();
      }
      await chatApi.remove(id);
      inflightRef.current.delete(id);
      if (activeIdRef.current === id) {
        selectConversation(null);
        setMessages([]);
        setAgentProcess(null);
      }
      await refreshConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const changeWorkspace = (next: WorkspaceView) => {
    // Non-admins cannot open admin workspaces
    if (
      user?.role !== 'admin' &&
      (next === 'admin-datasets' ||
        next === 'admin-documents' ||
        next === 'admin-tasks' ||
        next === 'admin-users')
    ) {
      return;
    }
    setWorkspace(next);
    if (next === 'chat' && !sidebarOpen) {
      setSidebarOpen(true);
    }
    if (next === 'knowledge') {
      void refreshKnowledgeBases();
    }
  };

  // If role is lost or user is not admin, leave admin workspaces
  useEffect(() => {
    if (
      user &&
      user.role !== 'admin' &&
      (workspace === 'admin-datasets' ||
        workspace === 'admin-documents' ||
        workspace === 'admin-tasks' ||
        workspace === 'admin-users')
    ) {
      setWorkspace('chat');
    }
  }, [user, workspace]);

  /** Indexed / ready for chat — only these are selectable. */
  const isDocReady = (d: DocumentItem) =>
    d.status === 'done' &&
    (d.ragflowDocumentId != null || d.chunkCount > 0);

  const readyDocsForKb = (kbId: string) =>
    (kbDocCache[kbId] || []).filter(isDocReady);

  const loadKbDocuments = useCallback(async (kbId: string) => {
    setKbDocsLoading((prev) => ({ ...prev, [kbId]: true }));
    try {
      const res = await docApi.list(kbId);
      setKbDocCache((prev) => ({
        ...prev,
        [kbId]: Array.isArray(res.items) ? res.items : [],
      }));
    } catch {
      setKbDocCache((prev) => ({ ...prev, [kbId]: prev[kbId] || [] }));
    } finally {
      setKbDocsLoading((prev) => ({ ...prev, [kbId]: false }));
    }
  }, []);

  const toggleKbExpand = (kbId: string) => {
    setExpandedKbIds((prev) => {
      const open = prev.includes(kbId);
      if (open) return prev.filter((x) => x !== kbId);
      if (!kbDocCache[kbId] && !kbDocsLoading[kbId]) {
        void loadKbDocuments(kbId);
      } else {
        // Refresh list on expand so newly indexed docs appear.
        void loadKbDocuments(kbId);
      }
      return [...prev, kbId];
    });
  };

  const toggleKb = (id: string) => {
    setSelectedKbIds((prev) => {
      if (prev.includes(id)) {
        const docs = kbDocCache[id] || [];
        if (docs.length) {
          const remove = new Set(docs.map((d) => d.id));
          setSelectedDocIds((dprev) => dprev.filter((x) => !remove.has(x)));
        }
        return prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
  };

  const toggleDoc = (kbId: string, docId: string) => {
    setSelectedDocIds((prev) => {
      if (prev.includes(docId)) return prev.filter((x) => x !== docId);
      return [...prev, docId];
    });
    setSelectedKbIds((prev) =>
      prev.includes(kbId) ? prev : [...prev, kbId],
    );
  };

  const selectDoc = useCallback((kbId: string, docId: string) => {
    setSelectedDocIds((prev) =>
      prev.includes(docId) ? prev : [...prev, docId],
    );
    setSelectedKbIds((prev) =>
      prev.includes(kbId) ? prev : [...prev, kbId],
    );
  }, []);

  const removeDoc = (docId: string) => {
    setSelectedDocIds((prev) => prev.filter((x) => x !== docId));
  };

  const clearKbSelection = () => {
    setSelectedKbIds([]);
    setSelectedDocIds([]);
  };

  const resolveDocMeta = useCallback(
    (docId: string): DocAtCandidate | null => {
      for (const kbId of Object.keys(kbDocCache)) {
        const found = (kbDocCache[kbId] || []).find((d) => d.id === docId);
        if (found) return { id: found.id, name: found.name, kbId };
      }
      return null;
    },
    [kbDocCache],
  );

  const selectedDocEntries = useMemo(() => {
    return selectedDocIds
      .map((id) => resolveDocMeta(id) ?? { id, name: id.slice(0, 8), kbId: '' })
      .filter(Boolean) as DocAtCandidate[];
  }, [selectedDocIds, resolveDocMeta]);

  const readyDocsForSelectedKbs = useMemo((): DocAtCandidate[] => {
    const out: DocAtCandidate[] = [];
    for (const kbId of selectedKbIds) {
      for (const d of (kbDocCache[kbId] || []).filter(isDocReady)) {
        out.push({ id: d.id, name: d.name, kbId });
      }
    }
    return out;
  }, [selectedKbIds, kbDocCache]);

  const atCandidates = useMemo(() => {
    if (!atQuery) return [] as DocAtCandidate[];
    return filterDocAtCandidates(readyDocsForSelectedKbs, atQuery.query);
  }, [atQuery, readyDocsForSelectedKbs]);

  // Lazy-load documents for selected KBs when @ menu opens
  useEffect(() => {
    if (!atQuery) return;
    for (const kbId of selectedKbIds) {
      if (!kbDocCache[kbId] && !kbDocsLoading[kbId]) {
        void loadKbDocuments(kbId);
      }
    }
  }, [atQuery, selectedKbIds, kbDocCache, kbDocsLoading, loadKbDocuments]);

  useEffect(() => {
    setAtActiveIndex(0);
  }, [atQuery?.query, atQuery?.start, atCandidates.length]);

  useEffect(() => {
    if (!atQuery) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [atActiveIndex, atQuery, atCandidates.length]);

  const syncAtQueryFromComposer = useCallback(() => {
    const el = composerInputRef.current;
    if (!el) {
      setAtQuery(null);
      return;
    }
    const caret = el.selectionStart ?? el.value.length;
    setAtQuery(extractAtQuery(el.value.slice(0, caret)));
  }, []);

  const applyAtCandidate = useCallback(
    (candidate: DocAtCandidate) => {
      const el = composerInputRef.current;
      if (!el || !atQuery) return;
      const mention = buildDocMentionText(candidate.name);
      const before = el.value.slice(0, atQuery.start);
      const after = el.value.slice(el.selectionStart ?? el.value.length);
      const next = `${before}${mention}${after}`.slice(0, 32000);
      setInput(next);
      selectDoc(candidate.kbId, candidate.id);
      setAtQuery(null);
      requestAnimationFrame(() => {
        const pos = before.length + mention.length;
        el.focus();
        el.setSelectionRange(pos, pos);
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
      });
    },
    [atQuery, selectDoc],
  );

  const mentionDocFromPicker = useCallback(
    (kbId: string, doc: DocumentItem) => {
      selectDoc(kbId, doc.id);
      const mention = buildDocMentionText(doc.name);
      const el = composerInputRef.current;
      if (!el) {
        setInput((prev) => `${prev}${prev && !/\s$/.test(prev) ? ' ' : ''}${mention}`.slice(0, 32000));
        return;
      }
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const before = el.value.slice(0, start);
      const after = el.value.slice(end);
      const pad =
        before.length > 0 && !/\s$/.test(before) ? ` ${mention}` : mention;
      const next = `${before}${pad}${after}`.slice(0, 32000);
      setInput(next);
      setAtQuery(null);
      requestAnimationFrame(() => {
        const pos = before.length + pad.length;
        el.focus();
        el.setSelectionRange(pos, pos);
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
      });
    },
    [selectDoc],
  );

  const stopSending = () => {
    // Only the conversation currently being viewed can stop its own stream.
    if (streamingConvIdRef.current && streamingConvIdRef.current === activeIdRef.current) {
      abortRef.current?.abort();
    }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sendingRef.current) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    sendingRef.current = true;
    setError('');
    setInput('');
    setAtQuery(null);
    if (composerInputRef.current) {
      composerInputRef.current.style.height = 'auto';
    }
    setModelPickerOpen(false);

    let convId: string | null = null;
    let assistantText = '';
    let assistantSources: CitationSource[] = [];
    let finalMessageId = '';
    let sawText = false;
    let userStopped = false;
    try {
      // Ensure we stream against a conversation that still exists for this user.
      // Fixes "conversation not found" when activeId is stale (deleted / desynced).
      convId = await ensureConversationId(activeIdRef.current);

      const tempUser: ChatMessage = {
        id: `tmp-user-${Date.now()}`,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      };
      const tempAssistant: ChatMessage = {
        id: `tmp-assistant-${Date.now()}`,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      };
      finalMessageId = tempAssistant.id;
      const initialProcess = createInitialProcess(tempAssistant.id);

      // Seed inflight synchronously (before any SSE frame) from the visible thread.
      const seedMessages =
        activeIdRef.current === convId
          ? [...messagesRef.current, tempUser, tempAssistant]
          : [tempUser, tempAssistant];
      inflightRef.current.set(convId, {
        messages: seedMessages,
        agentProcess: initialProcess,
      });
      streamingConvIdRef.current = convId;
      setStreamingConvId(convId);
      if (activeIdRef.current === convId) {
        messagesRef.current = seedMessages;
        setMessages(seedMessages);
        setAgentProcess(initialProcess);
      }

      const modelForSend = selectedModelId.trim();
      const streamOpts: {
        knowledgeBaseIds?: string[];
        documentIds?: string[];
        modelId?: string;
        signal: AbortSignal;
      } = { signal: ac.signal };
      if (selectedKbIds.length > 0) {
        streamOpts.knowledgeBaseIds = selectedKbIds;
      }
      if (selectedDocIds.length > 0 && selectedKbIds.length > 0) {
        streamOpts.documentIds = selectedDocIds;
      }
      if (modelForSend) {
        streamOpts.modelId = modelForSend;
      }

      const runStream = async (id: string) => {
        let sawConversationMissing = false;
        for await (const frame of chatApi.streamMessage(id, content, streamOpts)) {
          if (ac.signal.aborted) break;
          if (frame.event === 'text_delta') {
            if (!sawText) {
              sawText = true;
              patchInflight(id, (prev) => ({
                ...prev,
                agentProcess: applyTextStarted(prev.agentProcess),
              }));
            }
            assistantText += String(frame.data.delta || '');
            const text = assistantText;
            // Stream text only — never attach Sources mid-stream
            patchInflight(id, (prev) => {
              const copy = [...prev.messages];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') {
                copy[copy.length - 1] = {
                  ...last,
                  content: text,
                };
              }
              return { ...prev, messages: copy };
            });
          } else if (frame.event === 'tool_start') {
            const name = String(frame.data.name || 'tool');
            patchInflight(id, (prev) => ({
              ...prev,
              agentProcess: applyToolStart(prev.agentProcess, name),
            }));
          } else if (frame.event === 'tool_end') {
            const name = String(frame.data.name || 'tool');
            const ok = frame.data.ok !== false;
            const summary =
              typeof frame.data.summary === 'string'
                ? frame.data.summary
                : undefined;
            patchInflight(id, (prev) => ({
              ...prev,
              agentProcess: applyToolEnd(prev.agentProcess, name, ok, summary),
            }));
          } else if (frame.event === 'agent_status') {
            const kindRaw = String(frame.data.kind || 'info');
            const kind =
              kindRaw === 'limit' || kindRaw === 'aborted' || kindRaw === 'info'
                ? kindRaw
                : 'info';
            const message = String(frame.data.message || '');
            if (message) {
              patchInflight(id, (prev) => ({
                ...prev,
                agentProcess: applyAgentStatus(prev.agentProcess, kind, message),
              }));
            }
            if (kind === 'aborted') {
              userStopped = true;
            }
          } else if (frame.event === 'sources') {
            // Buffer only; show after the full assistant reply is complete
            const raw = frame.data.sources;
            if (Array.isArray(raw) && raw.length > 0) {
              assistantSources = raw as CitationSource[];
            }
          } else if (frame.event === 'assistant_message') {
            const finalContent = String(frame.data.content || assistantText);
            finalMessageId = String(frame.data.id || tempAssistant.id);
            const raw = frame.data.sources;
            // Prefer non-empty payload; keep mid-stream buffer if final list is empty
            if (Array.isArray(raw) && raw.length > 0) {
              assistantSources = raw as CitationSource[];
            }
            if (frame.data.aborted === true) userStopped = true;
            const midId = finalMessageId;
            patchInflight(id, (prev) => {
              const copy = [...prev.messages];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') {
                copy[copy.length - 1] = {
                  ...last,
                  id: midId,
                  content: finalContent,
                  // Still hide until stream ends
                  sources: undefined,
                };
              }
              return {
                messages: copy,
                agentProcess: prev.agentProcess
                  ? {
                      ...prev.agentProcess,
                      messageId: midId || prev.agentProcess.messageId,
                    }
                  : prev.agentProcess,
              };
            });
          } else if (frame.event === 'done') {
            if (frame.data.aborted === true) userStopped = true;
          } else if (frame.event === 'error') {
            const msg = String(frame.data.message || 'stream error');
            if (/conversation not found/i.test(msg)) {
              sawConversationMissing = true;
            } else if (activeIdRef.current === id) {
              setError(msg);
            }
          }
        }
        return sawConversationMissing;
      };

      let missing = await runStream(convId);
      // One automatic recovery: create a fresh conversation and resend once.
      // Do not recover after the user explicitly stopped.
      if (missing && !assistantText && !ac.signal.aborted) {
        setError('');
        // Move inflight cache from the missing id to the fresh conversation.
        const oldLive = inflightRef.current.get(convId);
        const fresh = await ensureConversationId(null);
        if (oldLive) {
          inflightRef.current.delete(convId);
          inflightRef.current.set(fresh, oldLive);
        }
        streamingConvIdRef.current = fresh;
        setStreamingConvId(fresh);
        convId = fresh;
        missing = await runStream(fresh);
        if (missing && activeIdRef.current === fresh) {
          setError('conversation not found');
        }
      } else if (missing && !ac.signal.aborted && activeIdRef.current === convId) {
        setError('conversation not found');
      }

      if (!ac.signal.aborted) {
        await refreshConversations();
      } else {
        userStopped = true;
        void refreshConversations().catch(() => undefined);
      }
    } catch (e) {
      const aborted =
        (e instanceof DOMException && e.name === 'AbortError') ||
        (e instanceof Error && e.name === 'AbortError') ||
        ac.signal.aborted;
      if (aborted) {
        userStopped = true;
      } else if (!convId || activeIdRef.current === convId) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      // Spec: always default to OPENAI_MODEL after each send completes.
      if (defaultModelId) {
        setSelectedModelId(defaultModelId);
      }
      // Attach Sources only after the stream is fully done.
      const stoppedEmpty =
        userStopped && !assistantText.trim() ? '(stopped)' : '';
      const doneConvId = convId;
      if (doneConvId) {
        patchInflight(doneConvId, (prev) => {
          const copy = [...prev.messages];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') {
            copy[copy.length - 1] = {
              ...last,
              id: finalMessageId || last.id,
              content: assistantText || stoppedEmpty || last.content,
              // Never inherit sources from a previous message; only this turn's list.
              sources: assistantSources,
            };
          }
          const done = applyProcessDone(prev.agentProcess, {
            sourceCount: assistantSources.length,
          });
          return {
            messages: copy,
            agentProcess: done
              ? {
                  ...done,
                  messageId: finalMessageId || done.messageId,
                }
              : done,
          };
        });
        // Stream finished — server has the final messages; drop live cache.
        // Keep React process panel if still viewing this chat (already applied).
        inflightRef.current.delete(doneConvId);
      }
      if (streamingConvIdRef.current === doneConvId) {
        streamingConvIdRef.current = null;
        setStreamingConvId(null);
      }
      sendingRef.current = false;
    }
  };

  const handleLocate = (source: CitationSource) => {
    if (!source.knowledgeBaseId && !source.appDocumentId && !source.documentName) {
      setError('This source has no linked document to locate.');
      return;
    }
    setError('');
    setLocateSource(source);
  };

  if (loading) {
    return <div className="app-loading">Loading…</div>;
  }

  if (!user) {
    return <Login />;
  }

  const activeTitle =
    conversations.find((c) => c.id === activeId)?.title || 'New conversation';

  /** Composer Stop + process panel only for the chat that is actually streaming. */
  const isActiveStreaming =
    streamingConvId !== null && streamingConvId === activeId;
  /** Another thread is generating — block starting a second concurrent stream. */
  const isOtherStreaming =
    streamingConvId !== null && streamingConvId !== activeId;

  const chatOpen = workspace === 'chat' && sidebarOpen;
  const selectedKbNames = knowledgeBases
    .filter((k) => selectedKbIds.includes(k.id))
    .map((k) => k.name);
  const activeModelId = selectedModelId || defaultModelId;
  const activeModelName =
    availableModels.find((m) => m.id === activeModelId)?.name ||
    activeModelId ||
    'Model';

  return (
    <div className="chat-page">
      <AppSidebar
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
        activeWorkspace={workspace}
        onChangeWorkspace={changeWorkspace}
        conversations={conversations}
        activeConversationId={activeId}
        onSelectConversation={(id) => {
          void openConversation(id);
        }}
        onCreateConversation={() => {
          void newChat();
        }}
        onDeleteConversation={(id) => {
          void deleteChat(id);
        }}
        username={user.username}
        isAdmin={user.role === 'admin'}
        onLogout={logout}
        explorer={{
          knowledgeBases,
          selectedKbIds,
          selectedDocIds,
          expandedKbIds,
          kbDocCache,
          kbDocsLoading,
          disabled: isActiveStreaming,
          readyDocsForKb,
          onToggleKb: toggleKb,
          onToggleDoc: toggleDoc,
          onToggleExpand: toggleKbExpand,
          onMentionDoc: mentionDocFromPicker,
          onClearSelection: clearKbSelection,
        }}
      />

      {locateSource && (
        <DocumentLocateDrawer
          source={locateSource}
          onClose={() => setLocateSource(null)}
        />
      )}

      {workspace === 'knowledge' ? (
        <div className="app-workspace knowledge-workspace">
          <KnowledgePanel onBackToChat={() => changeWorkspace('chat')} />
        </div>
      ) : workspace === 'memory' ? (
        <div className="app-workspace knowledge-workspace">
          <MemoryPanel onBackToChat={() => changeWorkspace('chat')} />
        </div>
      ) : workspace === 'admin-datasets' && user.role === 'admin' ? (
        <div className="app-workspace admin-workspace">
          <AdminDatasetsPanel
            onOpenDocuments={(ds) => {
              setAdminDataset(ds);
              setWorkspace('admin-documents');
            }}
          />
        </div>
      ) : workspace === 'admin-documents' && user.role === 'admin' ? (
        <div className="app-workspace admin-workspace">
          <AdminDocumentsPanel
            dataset={adminDataset}
            onBack={() => changeWorkspace('admin-datasets')}
          />
        </div>
      ) : workspace === 'admin-tasks' && user.role === 'admin' ? (
        <div className="app-workspace admin-workspace">
          <AdminTasksPanel />
        </div>
      ) : workspace === 'admin-users' && user.role === 'admin' ? (
        <div className="app-workspace admin-workspace">
          <AdminUsersPanel />
        </div>
      ) : workspace === 'admin-agent-sessions' && user.role === 'admin' ? (
        <div className="app-workspace admin-workspace">
          <AdminAgentSessionsPanel />
        </div>
      ) : (
        <main
          className={`chat-workspace ${chatOpen ? 'sidebar-open' : 'sidebar-closed'}`}
        >
          <div className="chat-topbar">
            <div className="chat-topbar-main">
              <div className="chat-topbar-left">
                <span className="chat-topbar-title" title={activeTitle}>
                  {activeTitle}
                </span>
              </div>
              <div className="chat-topbar-right">
                <span className="chat-topbar-hint">{user.username}</span>
              </div>
            </div>
          </div>

          <div className="chat-messages">
            {error && <p className="error-text chat-error">{error}</p>}
            {messages.length === 0 ? (
              <div className="welcome-message">
                <div>
                  <div className="welcome-mark">
                    <span aria-hidden />
                  </div>
                  <h2>CSB Knowledge Portal</h2>
                  <p>
                    Select one or more knowledge bases below, then ask a question.
                    Retrieval uses up to 10 chunks with source references.
                  </p>
                </div>
              </div>
            ) : (
              <div className="message-list">
                {messages.map((m, idx) => {
                  const sources = sourcesFromMessage(m);
                  // Hide Sources on the in-flight reply until streaming finishes
                  const isStreamingReply =
                    isActiveStreaming &&
                    m.role === 'assistant' &&
                    idx === messages.length - 1;
                  const showSources = !isStreamingReply && sources.length > 0;
                  const showProcess =
                    m.role === 'assistant' &&
                    agentProcess &&
                    (agentProcess.messageId === m.id ||
                      (isStreamingReply &&
                        agentProcess.messageId.startsWith('tmp-assistant')));
                  return (
                    <div key={m.id} className={`message ${m.role}`}>
                      <div className="role">{m.role}</div>
                      {m.role === 'assistant' ? (
                        <>
                          {showProcess && (
                            <AgentProcessPanel process={agentProcess} />
                          )}
                          {(m.content || !isStreamingReply) && (
                            <Markdown content={m.content || ''} />
                          )}
                          {showSources && (
                            <SourceReferences
                              sources={sources}
                              onLocate={handleLocate}
                            />
                          )}
                        </>
                      ) : (
                        <div className="content">{m.content}</div>
                      )}
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          <div className="input-area">
            <div className="composer">
              {(selectedKbIds.length > 0 || selectedDocIds.length > 0) && (
                <div className="composer-chips">
                  {selectedKbNames.map((name, i) => (
                    <button
                      key={selectedKbIds[i]}
                      type="button"
                      className="kb-chip"
                      onClick={() => toggleKb(selectedKbIds[i])}
                      title={`Remove ${name}`}
                      disabled={isActiveStreaming}
                    >
                      {name}
                      <span aria-hidden>×</span>
                    </button>
                  ))}
                  {selectedDocEntries
                    .slice(0, DOC_CHIP_VISIBLE_MAX)
                    .map((doc) => (
                      <button
                        key={doc.id}
                        type="button"
                        className="doc-chip"
                        onClick={() => removeDoc(doc.id)}
                        title={`Remove ${doc.name}`}
                        disabled={isActiveStreaming}
                      >
                        <FileTypeIcon name={doc.name} size={14} />
                        <span className="doc-chip-name">{doc.name}</span>
                        <span className="doc-chip-x" aria-hidden>
                          ×
                        </span>
                      </button>
                    ))}
                  {selectedDocEntries.length > DOC_CHIP_VISIBLE_MAX && (
                    <span
                      className="doc-chip-more"
                      title={selectedDocEntries
                        .slice(DOC_CHIP_VISIBLE_MAX)
                        .map((d) => d.name)
                        .join(', ')}
                    >
                      +{selectedDocEntries.length - DOC_CHIP_VISIBLE_MAX} more
                    </span>
                  )}
                  <button
                    type="button"
                    className="kb-chip-clear"
                    onClick={clearKbSelection}
                    disabled={isActiveStreaming}
                  >
                    Clear
                  </button>
                </div>
              )}

              {atQuery && (
                <div className="composer-at-menu" role="listbox" aria-label="Document mentions">
                  <div className="composer-at-menu-header">
                    <span>
                      {selectedKbIds.length === 0
                        ? 'Select a knowledge base to mention documents'
                        : atCandidates.length === 1
                          ? 'Files · 1 match'
                          : `Files · ${atCandidates.length} matches`}
                    </span>
                    <kbd>Tab / Enter</kbd>
                  </div>
                  <div className="composer-at-menu-list">
                    {selectedKbIds.length === 0 ? (
                      <div className="composer-at-menu-empty">
                        Pick one or more knowledge bases, then type @ to filter documents.
                      </div>
                    ) : atCandidates.length === 0 ? (
                      <div className="composer-at-menu-empty">
                        {selectedKbIds.some((id) => kbDocsLoading[id])
                          ? 'Loading documents…'
                          : 'No matching indexed documents'}
                      </div>
                    ) : (
                      atCandidates.map((doc, index) => {
                        const kbName =
                          knowledgeBases.find((k) => k.id === doc.kbId)?.name ||
                          '';
                        const active = index === atActiveIndex;
                        return (
                          <button
                            key={doc.id}
                            ref={(node) => {
                              atItemRefs.current[index] = node;
                            }}
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={`composer-at-option ${active ? 'is-active' : ''}`}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              applyAtCandidate(doc);
                            }}
                            onMouseEnter={() => setAtActiveIndex(index)}
                          >
                            <FileTypeIcon name={doc.name} size={16} />
                            <span className="composer-at-option-name">
                              {doc.name}
                            </span>
                            {kbName ? (
                              <span className="composer-at-option-kb">
                                {kbName}
                              </span>
                            ) : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              <textarea
                ref={composerInputRef}
                className="composer-input"
                value={input}
                placeholder={
                  selectedKbIds.length
                    ? 'Ask a question… Use @ to mention documents'
                    : 'Ask about your knowledge base, or pick knowledge bases below…'
                }
                onChange={(e) => {
                  const el = e.target;
                  setInput(el.value.slice(0, 32000));
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
                  const caret = el.selectionStart ?? el.value.length;
                  setAtQuery(extractAtQuery(el.value.slice(0, caret)));
                }}
                onClick={syncAtQueryFromComposer}
                onKeyUp={syncAtQueryFromComposer}
                onSelect={syncAtQueryFromComposer}
                maxLength={32000}
                onKeyDown={(e) => {
                  if (atQuery) {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setAtQuery(null);
                      return;
                    }
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      if (atCandidates.length) {
                        setAtActiveIndex((i) => (i + 1) % atCandidates.length);
                      }
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      if (atCandidates.length) {
                        setAtActiveIndex(
                          (i) =>
                            (i - 1 + atCandidates.length) % atCandidates.length,
                        );
                      }
                      return;
                    }
                    if (
                      (e.key === 'Enter' || e.key === 'Tab') &&
                      !e.shiftKey &&
                      atCandidates[atActiveIndex]
                    ) {
                      e.preventDefault();
                      applyAtCandidate(atCandidates[atActiveIndex]);
                      return;
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                disabled={isActiveStreaming}
                rows={1}
              />

              <div className="composer-toolbar">
                <div className="composer-toolbar-left" />

                <div className="composer-toolbar-right">
                  {availableModels.length > 1 && (
                    <div className="model-picker" ref={modelPickerRef}>
                      <button
                        type="button"
                        className={`model-picker-trigger ${
                          selectedModelId &&
                          defaultModelId &&
                          selectedModelId !== defaultModelId
                            ? 'has-selection'
                            : ''
                        }`}
                        onClick={() => {
                          setModelPickerOpen((v) => !v);
                        }}
                        disabled={isActiveStreaming}
                        aria-expanded={modelPickerOpen}
                        aria-haspopup="listbox"
                        title={activeModelName}
                      >
                        <span className="model-picker-label">
                          {activeModelName}
                        </span>
                        <span className="model-picker-chevron" aria-hidden>
                          ▾
                        </span>
                      </button>

                      {modelPickerOpen && (
                        <div
                          className="model-picker-menu composer-dropdown"
                          role="listbox"
                        >
                          {availableModels.map((m) => {
                            const active = m.id === activeModelId;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                role="option"
                                aria-selected={active}
                                className={`model-picker-option ${active ? 'active' : ''}`}
                                onClick={() => {
                                  setSelectedModelId(m.id);
                                  setModelPickerOpen(false);
                                }}
                              >
                                <span className="model-picker-option-name">
                                  {m.name}
                                </span>
                                {m.id === defaultModelId && (
                                  <span className="model-picker-option-badge">
                                    default
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {isActiveStreaming ? (
                    <button
                      className="send-btn stop-btn stop-btn-active"
                      type="button"
                      onClick={stopSending}
                      title="Stop generation"
                      aria-label="Stop generation"
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      className={`send-btn ${input.trim() && !isOtherStreaming ? 'send-btn-active' : ''}`}
                      type="button"
                      disabled={!input.trim() || isOtherStreaming}
                      onClick={() => void send()}
                      title={
                        isOtherStreaming
                          ? 'Wait for the other chat to finish, or open it and press Stop'
                          : 'Send message'
                      }
                      aria-label="Send message"
                    >
                      <span className="send-btn-icon" aria-hidden>
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                        >
                          <path
                            d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                      Send
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
