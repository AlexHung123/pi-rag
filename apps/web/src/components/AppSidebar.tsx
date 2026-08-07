import React, { useMemo, useState } from 'react';
import {
  Activity,
  BookOpen,
  Brain,
  Database,
  FileStack,
  FolderOpen,
  ListTodo,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
import type { Conversation } from '../services/api';
import ChatExplorerPanel, {
  type ChatExplorerPanelProps,
} from './ChatExplorerPanel';

export type WorkspaceView =
  | 'chat'
  | 'knowledge'
  | 'memory'
  | 'admin-datasets'
  | 'admin-documents'
  | 'admin-tasks'
  | 'admin-users'
  | 'admin-agent-sessions';

const formatDateTime = (value: string) =>
  new Date(value).toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

type AppSidebarProps = {
  isOpen: boolean;
  onToggle: () => void;
  activeWorkspace: WorkspaceView;
  onChangeWorkspace: (workspace: WorkspaceView) => void;
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onCreateConversation: () => void;
  onDeleteConversation: (id: string) => void;
  username: string;
  isAdmin?: boolean;
  onLogout: () => void | Promise<void>;
  /** When set and workspace is chat, show Knowledge EXPLORER under conversations. */
  explorer?: ChatExplorerPanelProps | null;
};

export default function AppSidebar({
  isOpen,
  onToggle,
  activeWorkspace,
  onChangeWorkspace,
  conversations,
  activeConversationId,
  onSelectConversation,
  onCreateConversation,
  onDeleteConversation,
  username,
  isAdmin = false,
  onLogout,
  explorer = null,
}: AppSidebarProps) {
  const [filter, setFilter] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, filter]);

  const workspaceItems: Array<{
    id: WorkspaceView;
    label: string;
    icon: React.ReactNode;
  }> = [
    { id: 'chat', label: 'Chat', icon: <MessageSquare size={20} /> },
    { id: 'knowledge', label: 'My Knowledge Base', icon: <BookOpen size={20} /> },
    { id: 'memory', label: 'My Memory', icon: <Brain size={20} /> },
    ...(isAdmin
      ? ([
          {
            id: 'admin-datasets',
            // Short rail label; full page title uses "Administration …"
            label: 'Admin Knowledge Bases',
            icon: <FolderOpen size={20} />,
          },
          {
            id: 'admin-documents',
            label: 'Admin Documents',
            icon: <FileStack size={20} />,
          },
          {
            id: 'admin-tasks',
            label: 'Admin Tasks',
            icon: <ListTodo size={20} />,
          },
          {
            id: 'admin-users',
            label: 'Admin Users',
            icon: <Users size={20} />,
          },
          {
            id: 'admin-agent-sessions',
            label: 'Admin Agents',
            icon: <Activity size={20} />,
          },
        ] as const)
      : []),
  ];

  return (
    <aside
      className={`app-navigation ${isOpen ? 'context-open' : 'context-closed'} workspace-${activeWorkspace}`}
      aria-label="App navigation"
    >
      <div className="app-rail">
        <div className="app-brand-mark" title="CSB Knowledge Portal">
          <Database size={20} strokeWidth={2.25} />
          <span className="sr-only">CSB Knowledge Portal</span>
        </div>

        <nav className="app-rail-nav" aria-label="Workspace">
          {workspaceItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`app-rail-button ${activeWorkspace === item.id ? 'active' : ''}`}
              aria-current={activeWorkspace === item.id ? 'page' : undefined}
              aria-label={item.label}
              title={item.label}
              onClick={() => {
                if (item.id === 'chat' && activeWorkspace === 'chat') {
                  onToggle();
                  return;
                }
                onChangeWorkspace(item.id);
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="app-rail-footer">
          <button
            type="button"
            className="app-rail-button"
            onClick={() => void onLogout()}
            aria-label="Sign out"
            title={`Sign out (${username})`}
          >
            <LogOut size={20} />
            <span>Sign out</span>
          </button>
          {activeWorkspace === 'chat' && (
            <button
              type="button"
              className="app-rail-button app-rail-toggle"
              onClick={onToggle}
              aria-label={isOpen ? 'Collapse conversation panel' : 'Expand conversation panel'}
              title={isOpen ? 'Collapse conversation panel' : 'Expand conversation panel'}
            >
              {isOpen ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
              <span>{isOpen ? 'Collapse' : 'Expand'}</span>
            </button>
          )}
        </div>
      </div>

      {activeWorkspace === 'chat' && (
        <section className="conversation-sidebar" aria-hidden={!isOpen}>
          <header className="conversation-sidebar-header">
            <div>
              <span className="conversation-sidebar-kicker">CSB Knowledge Portal</span>
              <h1>Conversations</h1>
            </div>
            <button
              type="button"
              className="conversation-create-button"
              onClick={onCreateConversation}
              aria-label="New conversation"
              title="New conversation"
            >
              <Plus size={18} />
            </button>
          </header>

          <label className="conversation-search">
            <Search size={16} />
            <span className="sr-only">Search conversations</span>
            <input
              type="search"
              placeholder="Search conversations"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>

          <div className="conversation-list" aria-label="Conversation list">
            {filtered.length === 0 && (
              <p className="conversation-empty">
                {conversations.length === 0
                  ? 'No conversations yet'
                  : 'No matching conversations'}
              </p>
            )}

            {filtered.map((conversation) => {
              const isMenuOpen = menuId === conversation.id;
              const isActive = activeConversationId === conversation.id;
              const count = conversation.messageCount ?? 0;

              return (
                <div
                  key={conversation.id}
                  className={`conversation-item-row ${isMenuOpen ? 'menu-open' : ''}`}
                >
                  <button
                    type="button"
                    className={`conversation-item ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      setMenuId(null);
                      onSelectConversation(conversation.id);
                      if (window.innerWidth <= 768) onToggle();
                    }}
                  >
                    <span className="conversation-title">{conversation.title}</span>
                    <span className="conversation-meta">
                      {count} messages · {formatDateTime(conversation.updatedAt)}
                    </span>
                  </button>

                  <div className="conversation-item-actions">
                    <button
                      type="button"
                      className="conversation-menu-trigger"
                      aria-label="Open conversation menu"
                      title="Conversation actions"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuId((cur) =>
                          cur === conversation.id ? null : conversation.id,
                        );
                      }}
                    >
                      <MoreHorizontal size={17} />
                    </button>

                    {isMenuOpen && (
                      <div
                        className="conversation-menu"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="conversation-menu-item danger"
                          onClick={() => {
                            const ok = window.confirm(
                              `Delete conversation "${conversation.title}"?`,
                            );
                            setMenuId(null);
                            if (ok) onDeleteConversation(conversation.id);
                          }}
                        >
                          <Trash2 size={15} />
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {explorer ? <ChatExplorerPanel {...explorer} /> : null}
        </section>
      )}
    </aside>
  );
}
