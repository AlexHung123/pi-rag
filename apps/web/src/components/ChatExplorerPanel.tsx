import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { DocumentItem, KnowledgeBase } from '../services/api';
import FileTypeIcon from './FileTypeIcon';

export type ChatExplorerPanelProps = {
  knowledgeBases: KnowledgeBase[];
  selectedKbIds: string[];
  selectedDocIds: string[];
  expandedKbIds: string[];
  kbDocCache: Record<string, DocumentItem[]>;
  kbDocsLoading: Record<string, boolean>;
  disabled?: boolean;
  readyDocsForKb: (kbId: string) => DocumentItem[];
  onToggleKb: (kbId: string) => void;
  onToggleDoc: (kbId: string, docId: string) => void;
  onToggleExpand: (kbId: string) => void;
  onMentionDoc: (kbId: string, doc: DocumentItem) => void;
  onClearSelection: () => void;
};

export default function ChatExplorerPanel({
  knowledgeBases,
  selectedKbIds,
  selectedDocIds,
  expandedKbIds,
  kbDocCache,
  kbDocsLoading,
  disabled = false,
  readyDocsForKb,
  onToggleKb,
  onToggleDoc,
  onToggleExpand,
  onMentionDoc,
  onClearSelection,
}: ChatExplorerPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  const selectionCount = useMemo(() => {
    if (selectedDocIds.length > 0) {
      return { kind: 'docs' as const, n: selectedDocIds.length };
    }
    if (selectedKbIds.length > 0) {
      return { kind: 'kbs' as const, n: selectedKbIds.length };
    }
    return null;
  }, [selectedDocIds.length, selectedKbIds.length]);

  return (
    <section
      className={`chat-explorer ${collapsed ? 'is-collapsed' : ''}`}
      aria-label="Knowledge explorer"
    >
      <header className="chat-explorer-header">
        <button
          type="button"
          className="chat-explorer-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight size={14} aria-hidden />
          ) : (
            <ChevronDown size={14} aria-hidden />
          )}
          <span className="chat-explorer-title">EXPLORER</span>
        </button>

        <div className="chat-explorer-header-right">
          {selectionCount && (
            <span
              className="chat-explorer-badge"
              title={
                selectionCount.kind === 'docs'
                  ? `${selectionCount.n} document${selectionCount.n === 1 ? '' : 's'} selected`
                  : `${selectionCount.n} knowledge base${selectionCount.n === 1 ? '' : 's'} selected`
              }
            >
              <span className="chat-explorer-badge-check" aria-hidden>
                ✓
              </span>
              {selectionCount.n}
            </span>
          )}
          {selectionCount && (
            <button
              type="button"
              className="chat-explorer-clear"
              onClick={onClearSelection}
              disabled={disabled}
              title="Clear knowledge selection"
            >
              Clear
            </button>
          )}
        </div>
      </header>

      {!collapsed && (
        <div className="chat-explorer-body">
          {knowledgeBases.length === 0 ? (
            <p className="chat-explorer-empty">
              No knowledge bases yet. Create one in My Knowledge Base.
            </p>
          ) : (
            <ul className="chat-explorer-kb-list">
              {knowledgeBases.map((kb) => {
                const kbSelected = selectedKbIds.includes(kb.id);
                const expanded = expandedKbIds.includes(kb.id);
                const readyDocs = readyDocsForKb(kb.id);
                const selectedInKb = readyDocs.filter((d) =>
                  selectedDocIds.includes(d.id),
                ).length;
                const loading = Boolean(kbDocsLoading[kb.id]);
                const hasCache = Array.isArray(kbDocCache[kb.id]);

                return (
                  <li key={kb.id} className="chat-explorer-kb">
                    <div
                      className={`chat-explorer-kb-row ${kbSelected ? 'is-selected' : ''}`}
                    >
                      <button
                        type="button"
                        className="chat-explorer-expand"
                        aria-expanded={expanded}
                        aria-label={
                          expanded
                            ? `Collapse documents in ${kb.name}`
                            : `Expand documents in ${kb.name}`
                        }
                        onClick={() => onToggleExpand(kb.id)}
                        disabled={disabled}
                      >
                        {expanded ? (
                          <ChevronDown size={14} aria-hidden />
                        ) : (
                          <ChevronRight size={14} aria-hidden />
                        )}
                      </button>
                      <button
                        type="button"
                        className="chat-explorer-kb-main"
                        onClick={() => onToggleKb(kb.id)}
                        disabled={disabled}
                        aria-pressed={kbSelected}
                        title={
                          kbSelected
                            ? `Deselect knowledge base ${kb.name}`
                            : `Select knowledge base ${kb.name}`
                        }
                      >
                        <span className="chat-explorer-kb-name" title={kb.name}>
                          {kb.name}
                        </span>
                        <span
                          className={`kb-visibility-badge sm ${kb.visibility === 'public' ? 'public' : 'private'}`}
                        >
                          {kb.visibility === 'public' ? 'Public' : 'Private'}
                        </span>
                        {selectedInKb > 0 && (
                          <span className="kb-doc-count-badge">
                            {selectedInKb} doc{selectedInKb === 1 ? '' : 's'}
                          </span>
                        )}
                      </button>
                    </div>

                    {expanded && (
                      <div className="chat-explorer-docs">
                        {loading && !hasCache ? (
                          <p className="chat-explorer-empty nested">
                            Loading documents…
                          </p>
                        ) : readyDocs.length === 0 ? (
                          <p className="chat-explorer-empty nested">
                            No indexed documents yet.
                          </p>
                        ) : (
                          <ul className="chat-explorer-doc-list">
                            {readyDocs.map((doc) => {
                              const docChecked = selectedDocIds.includes(doc.id);
                              return (
                                <li key={doc.id}>
                                  <div
                                    className={`kb-doc-row ${docChecked ? 'is-selected' : ''}`}
                                  >
                                    <button
                                      type="button"
                                      className="kb-doc-row-main"
                                      onClick={() => onToggleDoc(kb.id, doc.id)}
                                      disabled={disabled}
                                      title={
                                        docChecked
                                          ? `Deselect ${doc.name}`
                                          : `Select ${doc.name}`
                                      }
                                      aria-pressed={docChecked}
                                    >
                                      <FileTypeIcon name={doc.name} size={16} />
                                      <span
                                        className="kb-doc-row-name"
                                        title={doc.name}
                                      >
                                        {doc.name}
                                      </span>
                                      {docChecked ? (
                                        <span
                                          className="kb-doc-sel-dot"
                                          aria-hidden
                                        />
                                      ) : null}
                                    </button>
                                    <button
                                      type="button"
                                      className="kb-doc-mention-btn"
                                      disabled={disabled}
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        onMentionDoc(kb.id, doc);
                                      }}
                                      title={`Mention ${doc.name} in the message`}
                                    >
                                      @ mention
                                    </button>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
