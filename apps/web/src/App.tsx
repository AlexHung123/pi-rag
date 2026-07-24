import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './contexts/AuthContext';
import Login from './components/Login';
import Markdown from './components/Markdown';
import KnowledgePanel from './components/KnowledgePanel';
import {
  chatApi,
  type ChatMessage,
  type Conversation,
} from './services/api';

export default function App() {
  const { user, loading, logout } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [toolHint, setToolHint] = useState('');
  const [kbOpen, setKbOpen] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshConversations = useCallback(async () => {
    const res = await chatApi.list();
    setConversations(res.items);
    return res.items;
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshConversations().catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [user, refreshConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const openConversation = async (id: string) => {
    setActiveId(id);
    setError('');
    const detail = await chatApi.get(id);
    setMessages(detail.messages as ChatMessage[]);
  };

  const newChat = async () => {
    const c = await chatApi.create();
    await refreshConversations();
    setActiveId(c.id);
    setMessages([]);
  };

  const deleteChat = async (id: string) => {
    await chatApi.remove(id);
    if (activeId === id) {
      setActiveId(null);
      setMessages([]);
    }
    await refreshConversations();
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    setError('');
    setToolHint('');
    setInput('');

    let convId = activeId;
    try {
      if (!convId) {
        const c = await chatApi.create();
        convId = c.id;
        setActiveId(c.id);
        await refreshConversations();
      }

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
      setMessages((prev) => [...prev, tempUser, tempAssistant]);

      let assistantText = '';
      for await (const frame of chatApi.streamMessage(convId, content)) {
        if (frame.event === 'text_delta') {
          assistantText += String(frame.data.delta || '');
          const text = assistantText;
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last?.role === 'assistant') {
              copy[copy.length - 1] = { ...last, content: text };
            }
            return copy;
          });
        } else if (frame.event === 'tool_start') {
          setToolHint(`Running tool: ${String(frame.data.name || '')}`);
        } else if (frame.event === 'tool_end') {
          setToolHint('');
        } else if (frame.event === 'assistant_message') {
          const finalContent = String(frame.data.content || assistantText);
          const finalId = String(frame.data.id || tempAssistant.id);
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last?.role === 'assistant') {
              copy[copy.length - 1] = {
                ...last,
                id: finalId,
                content: finalContent,
              };
            }
            return copy;
          });
        } else if (frame.event === 'error') {
          setError(String(frame.data.message || 'stream error'));
        }
      }
      await refreshConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      setToolHint('');
    }
  };

  if (loading) {
    return <div className="app-loading">Loading…</div>;
  }

  if (!user) {
    return <Login />;
  }

  const activeTitle =
    conversations.find((c) => c.id === activeId)?.title || 'New chat';

  return (
    <div className="chat-page">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>pi-rag</h2>
          <button className="btn btn-secondary" type="button" onClick={newChat}>
            New chat
          </button>
        </div>
        <div className="sidebar-body">
          <div className="sidebar-section-title">Conversations</div>
          {conversations.length === 0 && (
            <p className="empty-hint" style={{ padding: '0 12px' }}>
              No conversations yet.
            </p>
          )}
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`conv-item ${activeId === c.id ? 'active' : ''}`}
              onClick={() => openConversation(c.id)}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.title}
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  deleteChat(c.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    deleteChat(c.id);
                  }
                }}
                style={{ color: 'var(--text-tertiary)' }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          <span>{user.username}</span>
          <button className="btn btn-ghost" type="button" onClick={() => logout()}>
            Logout
          </button>
        </div>
      </aside>

      <main className="main-pane">
        <div className="main-toolbar">
          <h3>{activeTitle}</h3>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => setKbOpen((v) => !v)}
          >
            {kbOpen ? 'Hide knowledge' : 'Knowledge'}
          </button>
        </div>

        <div className="chat-area">
          {error && <p className="error-text">{error}</p>}
          {messages.length === 0 ? (
            <div className="chat-empty">
              <div>
                <h2 style={{ marginTop: 0 }}>Domain RAG expert</h2>
                <p>
                  Create a private knowledge base, upload docs, parse chunks, then ask
                  questions. Your data stays isolated per account.
                </p>
              </div>
            </div>
          ) : (
            <div className="message-list">
              {toolHint && <div className="tool-chip">{toolHint}</div>}
              {messages.map((m) => (
                <div key={m.id} className={`message ${m.role}`}>
                  <div className="role">{m.role}</div>
                  {m.role === 'assistant' ? (
                    <Markdown content={m.content || (sending ? '…' : '')} />
                  ) : (
                    <div className="content">{m.content}</div>
                  )}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="composer">
          <div className="composer-inner">
            <textarea
              value={input}
              placeholder="Ask about your knowledge base, or say “create knowledge base Product Manual”…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              disabled={sending}
            />
            <button className="btn" type="button" disabled={sending || !input.trim()} onClick={send}>
              {sending ? '…' : 'Send'}
            </button>
          </div>
        </div>
      </main>

      <KnowledgePanel open={kbOpen} onClose={() => setKbOpen(false)} />
    </div>
  );
}
