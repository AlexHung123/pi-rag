import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  kbApi,
  modelsApi,
  type ChatMessage,
  type CitationSource,
  type Conversation,
  type KnowledgeBase,
} from './services/api';

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
  const [sending, setSending] = useState(false);
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
  const [kbPickerOpen, setKbPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
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
  const kbPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  /** Monotonic id so slower / out-of-order list responses cannot wipe newer state. */
  const listRequestIdRef = useRef(0);
  const sendingRef = useRef(false);
  /** In-flight chat SSE; Stop aborts this controller. */
  const abortRef = useRef<AbortController | null>(null);

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
          // Defer message clear to avoid setState-during-setState.
          Promise.resolve().then(() => {
            setMessages((msgs) => (msgs.length ? [] : msgs));
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
    setActiveId(null);
    setMessages([]);
    setInput('');
    setError('');
    setAgentProcess(null);
    setKnowledgeBases([]);
    setSelectedKbIds([]);
    setKbPickerOpen(false);
    setModelPickerOpen(false);
    setAvailableModels([]);
    setDefaultModelId('');
    setSelectedModelId('');
    setLocateSource(null);
    setAdminDataset(null);
    setWorkspace('chat');
    setSending(false);
    sendingRef.current = false;
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
  }, [messages, sending, agentProcess?.steps.length, agentProcess?.status]);

  useEffect(() => {
    if (!kbPickerOpen && !modelPickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (kbPickerOpen && !kbPickerRef.current?.contains(target)) {
        setKbPickerOpen(false);
      }
      if (modelPickerOpen && !modelPickerRef.current?.contains(target)) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [kbPickerOpen, modelPickerOpen]);

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
        setActiveId(null);
        setMessages([]);
        setAgentProcess(null);
      }
    }
    const c = await chatApi.create();
    setActiveId(c.id);
    await refreshConversations();
    return c.id;
  };

  const openConversation = async (id: string) => {
    setError('');
    setAgentProcess(null);
    setWorkspace('chat');
    try {
      const detail = await chatApi.get(id);
      setActiveId(id);
      setMessages(
        (detail.messages as ChatMessage[]).map((m) => ({
          ...m,
          sources: sourcesFromMessage(m),
        })),
      );
    } catch (e) {
      setActiveId(null);
      setMessages([]);
      setError(e instanceof Error ? e.message : String(e));
      await refreshConversations().catch(() => undefined);
    }
  };

  const newChat = async () => {
    try {
      setError('');
      setAgentProcess(null);
      const c = await chatApi.create();
      setActiveId(c.id);
      setMessages([]);
      setWorkspace('chat');
      if (!sidebarOpen) setSidebarOpen(true);
      await refreshConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteChat = async (id: string) => {
    try {
      await chatApi.remove(id);
      if (activeId === id) {
        setActiveId(null);
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

  const toggleKb = (id: string) => {
    setSelectedKbIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const clearKbSelection = () => setSelectedKbIds([]);

  const selectAllKbs = () =>
    setSelectedKbIds(knowledgeBases.map((k) => k.id));

  const stopSending = () => {
    abortRef.current?.abort();
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setSending(true);
    sendingRef.current = true;
    setError('');
    setInput('');
    if (composerInputRef.current) {
      composerInputRef.current.style.height = 'auto';
    }
    setKbPickerOpen(false);
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
      convId = await ensureConversationId(activeId);

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
      setAgentProcess(createInitialProcess(tempAssistant.id));
      setMessages((prev) => [...prev, tempUser, tempAssistant]);

      const modelForSend = selectedModelId.trim();
      const streamOpts: {
        knowledgeBaseIds?: string[];
        modelId?: string;
        signal: AbortSignal;
      } = { signal: ac.signal };
      if (selectedKbIds.length > 0) {
        streamOpts.knowledgeBaseIds = selectedKbIds;
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
              setAgentProcess((p) => applyTextStarted(p));
            }
            assistantText += String(frame.data.delta || '');
            const text = assistantText;
            // Stream text only — never attach Sources mid-stream
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') {
                copy[copy.length - 1] = {
                  ...last,
                  content: text,
                };
              }
              return copy;
            });
          } else if (frame.event === 'tool_start') {
            const name = String(frame.data.name || 'tool');
            setAgentProcess((p) => applyToolStart(p, name));
          } else if (frame.event === 'tool_end') {
            const name = String(frame.data.name || 'tool');
            const ok = frame.data.ok !== false;
            const summary =
              typeof frame.data.summary === 'string'
                ? frame.data.summary
                : undefined;
            setAgentProcess((p) => applyToolEnd(p, name, ok, summary));
          } else if (frame.event === 'agent_status') {
            const kindRaw = String(frame.data.kind || 'info');
            const kind =
              kindRaw === 'limit' || kindRaw === 'aborted' || kindRaw === 'info'
                ? kindRaw
                : 'info';
            const message = String(frame.data.message || '');
            if (message) {
              setAgentProcess((p) => applyAgentStatus(p, kind, message));
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
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') {
                copy[copy.length - 1] = {
                  ...last,
                  id: finalMessageId,
                  content: finalContent,
                  // Still hide until stream ends (sending → false below)
                  sources: undefined,
                };
              }
              return copy;
            });
            setAgentProcess((p) =>
              p ? { ...p, messageId: finalMessageId || p.messageId } : p,
            );
          } else if (frame.event === 'done') {
            if (frame.data.aborted === true) userStopped = true;
          } else if (frame.event === 'error') {
            const msg = String(frame.data.message || 'stream error');
            if (/conversation not found/i.test(msg)) {
              sawConversationMissing = true;
            } else {
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
        const fresh = await ensureConversationId(null);
        convId = fresh;
        missing = await runStream(fresh);
        if (missing) {
          setError('conversation not found');
        }
      } else if (missing && !ac.signal.aborted) {
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
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      // Spec: always default to OPENAI_MODEL after each send completes.
      if (defaultModelId) {
        setSelectedModelId(defaultModelId);
      }
      // Attach Sources only after the stream is fully done (with sending cleared)
      const stoppedEmpty =
        userStopped && !assistantText.trim() ? '(stopped)' : '';
      setMessages((prev) => {
        const copy = [...prev];
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
        return copy;
      });
      setAgentProcess((p) => {
        const done = applyProcessDone(p, {
          sourceCount: assistantSources.length,
        });
        if (!done) return done;
        return {
          ...done,
          messageId: finalMessageId || done.messageId,
        };
      });
      setSending(false);
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
                    sending &&
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
              {selectedKbIds.length > 0 && (
                <div className="composer-chips">
                  {selectedKbNames.map((name, i) => (
                    <button
                      key={selectedKbIds[i]}
                      type="button"
                      className="kb-chip"
                      onClick={() => toggleKb(selectedKbIds[i])}
                      title={`Remove ${name}`}
                      disabled={sending}
                    >
                      {name}
                      <span aria-hidden>×</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="kb-chip-clear"
                    onClick={clearKbSelection}
                    disabled={sending}
                  >
                    Clear
                  </button>
                </div>
              )}

              <textarea
                ref={composerInputRef}
                className="composer-input"
                value={input}
                placeholder={
                  selectedKbIds.length
                    ? 'Ask a question about the selected knowledge bases…'
                    : 'Ask about your knowledge base, or pick knowledge bases below…'
                }
                onChange={(e) => {
                  const el = e.target;
                  setInput(el.value.slice(0, 32000));
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
                }}
                maxLength={32000}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                disabled={sending}
                rows={1}
              />

              <div className="composer-toolbar">
                <div className="composer-toolbar-left" ref={kbPickerRef}>
                  <button
                    type="button"
                    className={`composer-tool-pill ${selectedKbIds.length ? 'has-selection' : ''}`}
                    onClick={() => {
                      setKbPickerOpen((v) => !v);
                      setModelPickerOpen(false);
                      if (!knowledgeBases.length) void refreshKnowledgeBases();
                    }}
                    disabled={sending}
                    aria-expanded={kbPickerOpen}
                    aria-haspopup="listbox"
                    title="Select knowledge bases"
                  >
                    <span className="composer-tool-icon" aria-hidden>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path
                          d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </span>
                    <span className="composer-tool-label">
                      {selectedKbIds.length === 0
                        ? 'Knowledge'
                        : selectedKbIds.length === 1
                          ? selectedKbNames[0] || '1 KB'
                          : `${selectedKbIds.length} KBs`}
                    </span>
                    <span className="composer-tool-chevron" aria-hidden>
                      ▾
                    </span>
                  </button>

                  {kbPickerOpen && (
                    <div
                      className="kb-select-dropdown composer-dropdown"
                      role="listbox"
                      aria-multiselectable
                    >
                      <div className="kb-select-actions">
                        <button
                          type="button"
                          onClick={selectAllKbs}
                          disabled={!knowledgeBases.length}
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          onClick={clearKbSelection}
                          disabled={!selectedKbIds.length}
                        >
                          Clear
                        </button>
                      </div>
                      {knowledgeBases.length === 0 ? (
                        <p className="kb-select-empty">
                          No knowledge bases yet. Create one in My Knowledge Base.
                        </p>
                      ) : (
                        <ul className="kb-select-options">
                          {knowledgeBases.map((kb) => {
                            const checked = selectedKbIds.includes(kb.id);
                            return (
                              <li key={kb.id}>
                                <label
                                  className={`kb-select-option ${checked ? 'checked' : ''}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleKb(kb.id)}
                                  />
                                  <span className="kb-option-text">
                                    <span className="kb-option-name">
                                      {kb.name}
                                      <span
                                        className={`kb-visibility-badge sm ${kb.visibility === 'public' ? 'public' : 'private'}`}
                                      >
                                        {kb.visibility === 'public'
                                          ? 'Public'
                                          : 'Private'}
                                      </span>
                                    </span>
                                    {kb.description ? (
                                      <span className="kb-option-desc">
                                        {kb.description}
                                      </span>
                                    ) : !kb.isOwner && kb.ownerUsername ? (
                                      <span className="kb-option-desc">
                                        by {kb.ownerUsername}
                                        {kb.myRole === 'editor' ||
                                        kb.myRole === 'viewer'
                                          ? ` · ${kb.myRole}`
                                          : ''}
                                      </span>
                                    ) : null}
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>

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
                          setKbPickerOpen(false);
                        }}
                        disabled={sending}
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

                  {sending ? (
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
                      className={`send-btn ${input.trim() ? 'send-btn-active' : ''}`}
                      type="button"
                      disabled={!input.trim()}
                      onClick={() => void send()}
                      title="Send message"
                      aria-label="Send message"
                    >
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
