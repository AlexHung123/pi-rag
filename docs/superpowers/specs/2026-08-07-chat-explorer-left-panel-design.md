# Chat Knowledge Explorer in left panel

**Date:** 2026-08-07  
**Status:** Approved  
**Product:** CSB Knowledge Base Portal (`pi-rag`)  
**Branch:** `feat/chat-layout-align-pi-web`  
**Reference:** User screenshot of pi-web EXPLORER (file rows, blue selection dot, hover `@ mention`)  
**Related:** `2026-08-07-chat-layout-pi-web-align-design.md` (message chrome, process panel, `@` autocomplete — still in scope; this doc relocates KB/doc selection UI)

## 1. Goal

Move chat **knowledge base / document selection** out of the composer Knowledge dropdown into a **left-panel EXPLORER** that matches the reference screenshot, while keeping retrieval semantics and `@` mention behavior unchanged.

### Success criteria

- Chat left context panel is split vertically: **Conversations** (top) + **EXPLORER** (bottom, collapsible).
- EXPLORER lists knowledge bases as expandable folders; ready documents as explorer rows (file icon, name, blue selection dot, hover `@ mention`).
- Composer **Knowledge pill + dropdown are removed**; chips + Clear + `@` autocomplete remain.
- Selection still drives `knowledgeBaseIds` / `documentIds` on send with the same server-enforced rules as today.

### Non-goals

- Backend / API / retrieval scope changes
- My Knowledge Base full-page admin UI
- Resizable split handle or dual-accordion conversation/explorer mode
- Filesystem paths, right-hand file viewer, or non-ready docs in the explorer

## 2. Decisions

| Topic | Choice |
|--------|--------|
| Layout | Fixed vertical split in chat context sidebar (Approach A) |
| Top section | Existing conversation list (search, new, delete) |
| Bottom section | EXPLORER, default expanded, header collapses the list |
| Hierarchy | KB folders → nested ready documents only |
| Composer KB control | Remove dropdown pill entirely |
| Composer chips | Keep KB chips, doc chips, Clear |
| State ownership | Remain in `App.tsx` (`selectedKbIds`, `selectedDocIds`, cache, expand) |
| New component | `ChatExplorerPanel` for explorer UI |
| Sidebar integration | `AppSidebar` mounts explorer under conversations when `workspace === 'chat'` |

## 3. UI surfaces

### 3.1 Left panel structure

```
[ app rail ]
[ conversation-sidebar ]
  header: Conversations + New
  search
  conversation list (flex: 1, scroll)
  ── ChatExplorerPanel ──
  header: ▾ EXPLORER | selection badge
  scrollable tree (max-height ~42% of sidebar)
```

- When EXPLORER is collapsed, only the header row remains.
- When the whole context sidebar is closed (`sidebarOpen === false`), both sections are hidden (unchanged rail behavior).

### 3.2 EXPLORER header

- Label: `EXPLORER` with chevron for collapse/expand.
- Selection badge: if `selectedDocIds.length > 0`, show green check + document count; else if `selectedKbIds.length > 0`, show green check + KB count; else no badge.
- Optional compact Clear control on the header when anything is selected (composer Clear remains the primary bulk clear).

### 3.3 KB rows

- Chevron expands/collapses nested docs; expand triggers lazy `docApi.list(kbId)` via existing `loadKbDocuments` / `kbDocCache`.
- Click name/row toggles whole-KB selection (`toggleKb`).
- Selected KB: subtle row highlight and/or checked affordance (no heavy checkbox chrome required; a11y via `aria-pressed` / checkbox if needed).
- Unchecking a KB clears that KB’s document ids from `selectedDocIds`.
- Show visibility or doc-selected count sparingly if space allows (truncate long names).

### 3.4 Document rows (ready only)

- Same readiness filter as today’s picker: indexed / ready for chat (`status === 'done'` and usable RAG id when exposed).
- Row: `FileTypeIcon` + truncated name + blue selection dot when selected.
- Click row: `toggleDoc(kbId, docId)` (auto-select parent KB if needed — existing behavior).
- Hover: show `@ mention` control; activates existing mention insertion + select parent KB + doc.
- Empty / loading states under an expanded KB: “Loading documents…” / “No indexed documents yet.”

### 3.5 Composer

- Remove: Knowledge tool pill, `kbPickerOpen`, dropdown listbox markup and outside-click handling for that menu.
- Keep: chips row, `@` menu (“Files · N matches”), model picker, send.
- Placeholder: still mention `@` when KBs are selected.

## 4. Selection semantics (unchanged)

| State | Effective retrieval scope |
|--------|---------------------------|
| `selectedKbIds` empty | No retrieval tools |
| KBs selected, `selectedDocIds` empty | Entire selected KB(s) |
| KBs + docs selected | Server-enforced document filter (existing mixed-expansion rules) |

`@` candidate scope remains: ready docs inside **selected** KBs only.

## 5. Implementation notes

### Files (expected)

| Path | Change |
|------|--------|
| `apps/web/src/components/ChatExplorerPanel.tsx` | **New** explorer UI |
| `apps/web/src/components/AppSidebar.tsx` | Mount explorer under conversation list; pass props |
| `apps/web/src/App.tsx` | Wire state/handlers; remove composer KB dropdown |
| `apps/web/src/styles/index.css` | Sidebar flex split + explorer row styles (reuse `.kb-doc-row` patterns where possible) |

### Props sketch (`ChatExplorerPanel`)

- Data: `knowledgeBases`, `selectedKbIds`, `selectedDocIds`, `expandedKbIds`, `kbDocCache`, `kbDocsLoading`
- Handlers: `onToggleKb`, `onToggleDoc`, `onToggleExpand`, `onMentionDoc`, `onClearSelection` (optional), `readyDocsForKb` or prefiltered lists
- Disabled while streaming if selection should freeze (match today’s composer disabled behavior)

### CSS

- Light gray panel background consistent with existing conversation sidebar.
- Explorer section border-top separator.
- Doc rows: compact height, hover background, blue selection dot, `@ mention` visible on hover/focus-within (already prototyped under `.kb-doc-row`).
- Header typography: small caps / uppercase muted label like reference.

## 6. Testing

Manual:

1. Open chat with sidebar open → Conversations above, EXPLORER below.
2. Expand a KB → docs load; select docs → blue dots + composer doc chips.
3. Select KB only (no docs) → KB chip; send uses whole-KB scope.
4. Hover doc → `@ mention` inserts token and selects doc + KB.
5. Type `@` in composer with KBs selected → autocomplete still works.
6. Collapse EXPLORER → only header; expand again restores tree.
7. Clear chips → explorer selection clears.
8. Composer has no Knowledge pill/dropdown.
9. Mobile: open sidebar → same vertical split scrolls independently within sections.

## 7. Out of scope / follow-ups

- Drag-resize between conversations and explorer
- Persist expanded KBs / explorer collapse across sessions
- Show non-ready docs with status badges in explorer
- Move conversation list elsewhere
