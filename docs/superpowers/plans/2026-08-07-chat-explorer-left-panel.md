# Chat Knowledge Explorer Left Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move chat knowledge-base/document selection from the composer Knowledge dropdown into a collapsible EXPLORER section under Conversations in the left sidebar, matching the pi-web explorer screenshot.

**Architecture:** Keep selection state (`selectedKbIds`, `selectedDocIds`, expand/cache) in `App.tsx`. Extract presentational explorer UI into `ChatExplorerPanel`. Mount it inside `AppSidebar` below the conversation list. Remove the composer Knowledge pill/dropdown. Reuse existing toggle/mention handlers and ready-doc filters; no API changes.

**Tech Stack:** React 18, TypeScript, Vite, existing Lucide icons + `FileTypeIcon`, CSS in `apps/web/src/styles/index.css`

**Spec:** `docs/superpowers/specs/2026-08-07-chat-explorer-left-panel-design.md`

**Note:** `apps/web` has no unit-test runner. Verification is `npm run build` (tsc + vite) plus the manual checklist in Task 5.

---

## File map

| Path | Responsibility |
|------|----------------|
| `apps/web/src/components/ChatExplorerPanel.tsx` | **Create** — EXPLORER header, KB tree, doc rows, collapse |
| `apps/web/src/components/AppSidebar.tsx` | **Modify** — accept explorer props; render panel under conversation list |
| `apps/web/src/App.tsx` | **Modify** — wire props; remove `kbPickerOpen` + composer dropdown; drop `knowledgePillLabel` |
| `apps/web/src/styles/index.css` | **Modify** — sidebar flex split + explorer section styles |

---

### Task 1: Create `ChatExplorerPanel`

**Files:**
- Create: `apps/web/src/components/ChatExplorerPanel.tsx`

- [ ] **Step 1: Add the component file**

Create `apps/web/src/components/ChatExplorerPanel.tsx` with full contents:

```tsx
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
          <span className="chat-explorer-title">Explorer</span>
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
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ChatExplorerPanel.tsx
git commit -m "feat(web): add ChatExplorerPanel for left-sidebar KB tree"
```

---

### Task 2: Mount explorer in `AppSidebar`

**Files:**
- Modify: `apps/web/src/components/AppSidebar.tsx`

- [ ] **Step 1: Extend props and render explorer under the conversation list**

1. Add import at top (after existing imports):

```tsx
import ChatExplorerPanel, {
  type ChatExplorerPanelProps,
} from './ChatExplorerPanel';
```

2. Extend `AppSidebarProps` with optional explorer config (only used for chat):

```tsx
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
```

3. Destructure `explorer = null` in the component parameters.

4. Inside the chat `conversation-sidebar` section, **after** the `conversation-list` `</div>`, add:

```tsx
{explorer ? <ChatExplorerPanel {...explorer} /> : null}
```

The structure should look like:

```tsx
{activeWorkspace === 'chat' && (
  <section className="conversation-sidebar" aria-hidden={!isOpen}>
    <header className="conversation-sidebar-header">
      {/* unchanged */}
    </header>

    <label className="conversation-search">
      {/* unchanged */}
    </label>

    <div className="conversation-list" aria-label="Conversation list">
      {/* unchanged conversation items */}
    </div>

    {explorer ? <ChatExplorerPanel {...explorer} /> : null}
  </section>
)}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/AppSidebar.tsx
git commit -m "feat(web): mount ChatExplorerPanel under conversation list"
```

---

### Task 3: CSS — sidebar split + explorer chrome

**Files:**
- Modify: `apps/web/src/styles/index.css`

- [ ] **Step 1: Ensure conversation list does not eat the explorer**

`.conversation-list` already has `flex: 1` and `min-height: 0`. Change bottom padding so the explorer sits flush:

Find:

```css
.conversation-list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  padding: 4px 8px 16px;
  scrollbar-width: thin;
}
```

Replace with:

```css
.conversation-list {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  padding: 4px 8px 8px;
  scrollbar-width: thin;
}
```

- [ ] **Step 2: Append explorer styles**

Append at the end of the conversation-sidebar related area (or near existing `.kb-doc-row` rules) the following block:

```css
/* Chat left-panel Knowledge EXPLORER (pi-web style) */
.chat-explorer {
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  min-height: 0;
  max-height: 42%;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-secondary, var(--surface-secondary));
}

.chat-explorer.is-collapsed {
  max-height: none;
  flex: 0 0 auto;
}

.chat-explorer-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
  padding: 6px 10px 6px 8px;
}

.chat-explorer-toggle {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 2px 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-tertiary);
  font: inherit;
  cursor: pointer;
}

.chat-explorer-toggle:hover {
  background: var(--color-sidebar-hover);
  color: var(--text-secondary);
}

.chat-explorer-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.chat-explorer-header-right {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.chat-explorer-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.chat-explorer-badge-check {
  color: #16a34a;
  font-size: 12px;
  line-height: 1;
}

.chat-explorer-clear {
  margin: 0;
  padding: 2px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.chat-explorer-clear:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--color-sidebar-hover);
}

.chat-explorer-clear:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chat-explorer-body {
  min-height: 0;
  flex: 1 1 auto;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 6px 10px;
  scrollbar-width: thin;
}

.chat-explorer-empty {
  margin: 0;
  padding: 10px 8px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.4;
}

.chat-explorer-empty.nested {
  padding: 4px 8px 8px 28px;
}

.chat-explorer-kb-list,
.chat-explorer-doc-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.chat-explorer-kb {
  margin: 0;
}

.chat-explorer-kb-row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 28px;
  border-radius: 6px;
}

.chat-explorer-kb-row.is-selected {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}

.chat-explorer-expand {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}

.chat-explorer-expand:hover:not(:disabled) {
  background: var(--color-sidebar-hover);
  color: var(--text-secondary);
}

.chat-explorer-kb-main {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 4px 6px 4px 2px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.chat-explorer-kb-main:hover:not(:disabled) {
  background: var(--color-sidebar-hover);
}

.chat-explorer-kb-main:disabled,
.chat-explorer-expand:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.chat-explorer-kb-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-size: 12.5px;
  font-weight: 600;
}

.chat-explorer-docs {
  padding: 0 0 4px 6px;
}

.chat-explorer .kb-doc-row {
  padding-left: 18px;
}
```

Reuse existing `.kb-doc-row`, `.kb-doc-sel-dot`, `.kb-doc-mention-btn` rules (already in the file). Do not delete them.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles/index.css
git commit -m "style(web): chat explorer left-panel layout and chrome"
```

---

### Task 4: Wire `App.tsx` and remove composer Knowledge dropdown

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Remove picker-only state and outside-click for KB menu**

1. Delete state:

```tsx
const [kbPickerOpen, setKbPickerOpen] = useState(false);
```

2. Delete ref:

```tsx
const kbPickerRef = useRef<HTMLDivElement>(null);
```

3. Replace the outside-click effect so it only handles the model picker:

Find the effect that depends on `[kbPickerOpen, modelPickerOpen]` and replace with:

```tsx
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
```

4. In `applyAtCandidate`, remove `setKbPickerOpen(false);` (keep other logic).

5. In `mentionDocFromPicker`, remove `setKbPickerOpen(false);`.

6. Delete unused helpers that only served the dropdown bulk KB actions if nothing else uses them:
   - `selectAllKbs` — remove if only used by the dropdown.
   - `selectAllDocs` / `clearDocs` — remove if only used by the dropdown (explorer does not need per-KB Select all/Clear in v1; header Clear uses `clearKbSelection`).

If `selectAllDocs` / `clearDocs` are only referenced in the dropdown JSX being deleted, remove those functions too.

7. Delete `knowledgePillLabel` IIFE (only used by the pill label).

- [ ] **Step 2: Pass `explorer` props into `AppSidebar`**

On the existing `<AppSidebar ... />` call, add:

```tsx
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
```

Place this after `onLogout` (or with the other props). Only meaningful when `workspace === 'chat'` (sidebar already gates on chat).

**Note:** `isActiveStreaming` is defined later in the component body today. Move the `isActiveStreaming` / `isOtherStreaming` constants **above** the `return (` so they exist before JSX, if they are not already above the return. Currently they sit just above `return` — that is fine as long as `explorer={{...}}` is inside the same return after those consts.

- [ ] **Step 3: Remove composer Knowledge pill + dropdown**

In the composer toolbar, find:

```tsx
<div className="composer-toolbar-left" ref={kbPickerRef}>
  <button
    type="button"
    className={`composer-tool-pill ...`}
    ...
  >
    ...
  </button>

  {kbPickerOpen && (
    <div className="kb-select-dropdown composer-dropdown" ...>
      ... entire dropdown ...
    </div>
  )}
</div>
```

Replace the whole left toolbar block with an empty left slot **or** remove left content while keeping layout:

```tsx
<div className="composer-toolbar-left" />
```

Keep `composer-toolbar-right` (model picker + send) unchanged.

Also update model picker open handler: remove `setKbPickerOpen(false)` if present when opening the model menu.

- [ ] **Step 4: Ensure knowledge bases load for chat**

`refreshKnowledgeBases` already runs on login. When opening chat workspace, `changeWorkspace` already refreshes KBs for knowledge view. Optionally, when mounting chat with empty `knowledgeBases`, call refresh once — only if you observe empty explorer after login; otherwise skip (avoid scope creep). Existing `useEffect` on `userId` already calls `refreshKnowledgeBases`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): wire left explorer; remove composer Knowledge dropdown"
```

---

### Task 5: Verify build and manual checklist

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + production build**

From repo root (or `apps/web`):

```bash
cd apps/web
npm run build
```

Expected: exit code 0; `tsc -b` and `vite build` succeed with no errors about missing `kbPickerOpen`, unused imports, or wrong `AppSidebar` props.

If `tsc` reports unused symbols (e.g. leftover `selectAllKbs`), delete them and rebuild.

- [ ] **Step 2: Manual UI checklist** (dev server optional: `npm run dev` in `apps/web`)

1. Chat sidebar open → Conversations on top, **Explorer** section below with border separator.
2. Expand a KB → documents load; select docs → blue dots + composer doc chips.
3. Select KB only (no docs) → KB chip; explorer badge shows KB count.
4. Hover doc → `@ mention` appears; click inserts mention and selects doc + KB.
5. Type `@` with KBs selected → autocomplete still works.
6. Collapse Explorer header → only header row; expand restores tree.
7. Clear (header or chips) → selection cleared in both explorer and chips.
8. Composer has **no** Knowledge pill/dropdown.
9. While streaming a reply, explorer controls are disabled.
10. Mobile / narrow: open sidebar → both sections usable (independent scroll).

- [ ] **Step 3: Final commit only if Step 1–2 required fixups**

```bash
git add -A apps/web
git commit -m "fix(web): chat explorer build/UX follow-ups"
```

Skip this commit if nothing changed.

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| Vertical split Conversations + EXPLORER | 2, 3 |
| Collapsible EXPLORER header | 1, 3 |
| KB folders + expand lazy load | 1, 4 (existing `toggleKbExpand`) |
| Doc rows: icon, name, blue dot, hover `@ mention` | 1 (reuses CSS) |
| Remove composer Knowledge dropdown | 4 |
| Keep chips + `@` autocomplete | 4 (untouched chips/`@` paths) |
| Same selection semantics / no API change | 4 (same handlers) |
| Selection badge on header | 1 |
| Disabled while streaming | 4 (`disabled: isActiveStreaming`) |

## Placeholder scan

No TBD/TODO steps; component and CSS provided inline; verification commands explicit.

## Type consistency

- Props type: `ChatExplorerPanelProps` exported from `ChatExplorerPanel.tsx`, imported as `explorer?: ChatExplorerPanelProps | null` on `AppSidebar`.
- Handlers: `onToggleKb` / `onToggleDoc` / `onToggleExpand` / `onMentionDoc` / `onClearSelection` map to existing `toggleKb`, `toggleDoc`, `toggleKbExpand`, `mentionDocFromPicker`, `clearKbSelection`.
- Ready docs: parent still owns `readyDocsForKb` + `isDocReady`.
