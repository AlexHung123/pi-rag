# RAG Quality P1 Design

**Date:** 2026-07-28  
**Status:** Implemented (P1a–b–d); **P1c Fast RAG removed** (agent-only chat)  
**Product:** CSB Knowledge Base Portal (`pi-rag`)  
**Depends on:** P0 ([`2026-07-28-rag-quality-p0.md`](./2026-07-28-rag-quality-p0.md))  
**Next (ingest):** [`2026-07-28-rag-quality-p2-design.md`](./2026-07-28-rag-quality-p2-design.md)  
**Roadmap:** [`2026-07-28-rag-quality-roadmap.md`](./2026-07-28-rag-quality-roadmap.md)  
**Plan checklist:** [`../plans/2026-07-28-rag-quality.md`](../plans/2026-07-28-rag-quality.md)

---

## 1. Goal

P0 improved **how we retrieve** (hybrid params, evidence format, rewrite, multi-query).  
P1 improves **how we choose retrieval and answer**:

1. More than one retrieval leg (semantic + keyword + document browse)
2. Reuse P0 modules; do not reimplement RAGFlow or replace the product architecture
3. Chat remains **agent-only** (no separate fast RAG path)

**Non-goals for P1:** Fast RAG / `mode=fast` (removed), chunk presets (P2), golden-set eval UI (P3), GraphRAG/Wiki, in-house vector DB.

---

## 2. Current state (post-P0)

| Piece | Status |
|-------|--------|
| `retrieve_chunks` | Hybrid/semantic via RAGFlow; evidence + threshold + multi-query |
| Query rewrite | Injected as suggested search question when KBs selected |
| `listChunks` | Used by document preview API only, not agent tools |
| Chat QA | Agent-only (`pi-agent-core` + tools) |
| Citation UI | Filled from tool `details.sources` on `retrieve_chunks` |

### Gaps P1 closes

| Gap | Impact |
|-----|--------|
| Only semantic/hybrid tool | Error codes, clause numbers, proper nouns often miss |
| Must tool-call to get evidence | Extra latency; model may skip retrieve |
| No “open this document” tool | Cannot expand after a hit names a doc |
| Scope/ownership logic inlined in one tool | Will drift if we add more tools |

---

## 3. Design principles

1. **RAGFlow-first** — keyword path still uses retrieval (or list-chunks keywords), not a local full-text index.
2. **Reuse P0** — `rag-config`, `evidence`, `query-rewrite`, `RagflowService.retrieve`.
3. **Shared scope resolution** — one ownership + id-mapping helper for all tools.
4. **Same evidence contract** — every retrieval tool returns:
   - `content[].text` = human-readable evidence with `[n]` indices  
   - `details.sources` = `CitationSource[]` for SSE/UI  
5. **Incremental PRs** — ship dual tools before document browse / adjacent expand.
6. **Isolation unchanged** — only UI-selected, readable KBs; never invent KB/document ids.

---

## 4. Slice order (recommended)

```text
P1a  Shared scope + keyword_search     ← do first (highest ROI)
P1b  list_document_chunks              ← depends on P1a helper
P1c  Fast RAG path                     ← REMOVED (not needed; agent-only)
P1d  Adjacent-chunk expand             ← optional; skip if API weak
```

| Slice | Effort (rough) | Risk | Status |
|-------|----------------|------|--------|
| P1a | 0.5–1.5 days | Low | Shipped |
| P1b | 0.5–1 day | Low | Shipped |
| P1c | — | — | **Removed** |
| P1d | ~0.5 day or cut | Low | Shipped |

**Minimum valuable P1** = **P1a only** (semantic + keyword dual tools).

---

## 5. P1a — Shared scope + `keyword_search`

### 5.1 Extract `resolveRetrievalScope`

**Problem:** `retrieve_chunks` currently embeds:

- Validate `knowledgeBaseIds` (must come from UI selection)
- `knowledge.list` + prisma readable filter
- Map RAGFlow dataset/document ids → app ids / names

**Proposal:** new module e.g. `apps/api/src/rag/resolve-scope.ts`:

```ts
resolveRetrievalScope(userId: string, knowledgeBaseIds: string[]): Promise<{
  ok: true;
  accessible: Array<{ id; name; ragflowDatasetId; documents: ... }>;
  datasetIds: string[];
  mapHit(hit: RetrieveHit): MappedHit;
} | { ok: false; message: string }>
```

Rules (unchanged product policy):

- Empty `knowledgeBaseIds` → error message; do not auto-pick KBs
- Only owned / public / member-readable KBs
- Tools never invent ids

All of `retrieve_chunks`, `keyword_search`, `list_document_chunks` call this helper.

### 5.2 `keyword_search` tool

**When:** error codes, clause numbers, names, exact phrases.  
**Not for:** conceptual “how does X work” (use `retrieve_chunks`).

#### Implementation (primary) — shipped

Still call `POST /api/v1/retrieval`, with keyword-biased params **and** RAGFlow ES flag:

| Field | Typical value | Notes |
|-------|---------------|--------|
| `question` | tool `query` string | Short phrase / code / title |
| `vector_similarity_weight` | `0.1` (env override) | Prefer term vs default ~0.7 |
| `similarity_threshold` | slightly lower than semantic | Literal hits may score differently |
| `keyword` | `true` (env `RAG_KEYWORD_ENABLE_ES`) | Enables ElasticSearch keyword matching ([HTTP API](https://ragflow.io/docs/http_api_reference)) |
| `top_k` / `page_size` | same over-retrieve pattern as P0 | Reuse `getRagRetrievalConfig()` with overrides |

Env (in `.env.example`):

```text
RAG_KEYWORD_VECTOR_WEIGHT=0.1
RAG_KEYWORD_SIMILARITY_THRESHOLD=0.1
RAG_KEYWORD_ENABLE_ES=true
```

#### Implementation (fallback / later)

If primary path is weak on a given deploy:

- `listChunks(dataset, doc, { keywords })` across docs — expensive; only if needed.

**Shipped:** primary path only (`keyword=true` + low vector weight).

#### Tool schema

```ts
{
  name: 'keyword_search',
  parameters: {
    query: string,                 // required
    knowledgeBaseIds: string[],  // required from UI selection
    topK?: number
  }
}
```

#### Output

- Same `formatEvidenceForModel` + `mappedHitsToCitationSources` as P0
- `details.sources` so the chat layer can attach citations

#### Agent event wiring

Today `agent.service` only harvests sources from tool name `retrieve_chunks`.  
**Change:** harvest `details.sources` from **any** successful tool result that includes `sources` (or whitelist: `retrieve_chunks` | `keyword_search` | `list_document_chunks`).

When multiple tools run in one turn: **merge by chunk id, keep highest score, re-index `[n]`** for the final `sources` event (simple last-tool-wins is acceptable for MVP if merge is deferred — prefer merge).

### 5.3 Prompt routing

Extend `DOMAIN_SYSTEM_PROMPT` (and selected-KB prefix if needed):

| Question type | Tool |
|---------------|------|
| Concepts, mechanisms, summaries, comparisons | `retrieve_chunks` |
| Codes, clause numbers, proper nouns, exact phrases | `keyword_search` |
| Complementary | May call both in sequence |

Do not rely on perfect routing; wrong keyword call is cheap.

### 5.4 Acceptance (P1a)

- [x] Scope helper used by retrieve + keyword (no duplicated ownership logic)
- [x] `keyword_search` returns evidence + `details.sources`
- [x] Citations appear in SSE for keyword-only answers (multi-tool harvest + merge)
- [x] Prompt documents tool choice
- [x] Build passes

---

## 6. P1b — `list_document_chunks`

### Purpose

After retrieve names a document, or user says “open 《差旅制度》 section…”, browse that document’s chunks with a token budget.

### Schema

```ts
{
  name: 'list_document_chunks',
  parameters: {
    appDocumentId: string,   // portal UUID only
    page?: number,           // default 1
    pageSize?: number,       // default 5–10, hard cap e.g. 20
    keywords?: string        // optional in-doc filter
  }
}
```

### Flow

1. Load document by id + user canRead(KB)
2. Resolve `ragflowDocumentId` + dataset id
3. `RagflowService.listChunks`
4. Format as evidence; **total char budget** (e.g. 6–8k) across returned chunks
5. `details.sources` with `appDocumentId` filled for Locate UI

### Prompt

Use only when document id is known (prior sources / user naming). Do not invent document ids.

### Acceptance (P1b)

- [x] Unauthorized document → not found / empty, no leak
- [x] Budget prevents context blowups
- [x] Sources usable for preview locate when ids present

---

## 7. P1c — Fast RAG path (**removed**)

> **Decision:** Product does not need a non-agent Fast RAG path. Chat is agent-only.
> Removed: `FastRagService`, `PostMessageDto.mode`, UI “智能体 / 快速问答” toggle, and chat branching.

Historical idea (not shipped / no longer in tree): rewrite → hybrid retrieve → stream LLM without the tool loop, via `mode=fast`.

---

## 8. P1d — Adjacent chunk expand (shipped)

### Idea

On a hit, attach chunk i−1 / i+1 when ordering is available, for continuity without raising `page_size` blindly.

### Implementation

- Module: `apps/api/src/rag/expand-hits.ts`
- Uses `listChunks` **document list order** (not PDF position geometry)
- Top N hits (`RAG_ADJACENT_EXPAND_MAX_HITS`, default 3); fail-open per document
- Shared by `retrieve_chunks` and `keyword_search`
- Toggle: `RAG_ADJACENT_EXPAND=true` (default on)

---

## 9. File map (proposed)

| Path | Slice | Action |
|------|-------|--------|
| `apps/api/src/rag/resolve-scope.ts` | P1a | **New** — ownership + id map |
| `apps/api/src/rag/evidence.ts` | P1a–d | Reuse; optional expand |
| `apps/api/src/rag/rag-config.ts` | P1a | Keyword weight/threshold env |
| `apps/api/src/ragflow/ragflow.service.ts` | P1a | Ensure retrieve accepts weight overrides (already does via options) |
| `apps/api/src/agent/agent.tools.ts` | P1a–b | Add tools; call resolve-scope; prompt |
| `apps/api/src/agent/agent.service.ts` | P1a | Multi-tool sources harvest |
| `.env.example` | P1a | Keyword-related env |

---

## 10. PR sequence

| PR | Content |
|----|---------|
| **PR-P1a** | `resolve-scope` + `keyword_search` + prompt + multi-tool sources |
| **PR-P1b** | `list_document_chunks` |
| **PR-P1c** | ~~`mode=fast`~~ — **cancelled / removed** |
| **PR-P1d** | Adjacent expand (or skip with note) |

Suggested branch naming: `feat/rag-quality-p1a`, or single `feat/rag-quality-p1` with stacked commits.

---

## 11. Testing plan

### Automated

- Unit: `resolveRetrievalScope` denial paths (wrong id, empty ids)
- Unit: evidence merge / re-index if implemented
- Build: `npm run build -w @pi-rag/api`

### Manual (mock + real RAGFlow)

| Case | Expected |
|------|----------|
| Conceptual question + selected KB | `retrieve_chunks` |
| Exact code / phrase | `keyword_search` hits more reliably than semantic-only |
| list by `appDocumentId` | Chunks + sources; foreign id fails closed |
| No KB selected | No invent; ask to select / pure chat |

---

## 12. Risks

| Risk | Mitigation |
|------|------------|
| RAGFlow keyword weight behaves differently by version | Env knobs; log retrieve params; test on target deploy |
| Agent ignores keyword tool | Clear tool descriptions; optional later: stronger tool-use prompting |
| Multi-tool citation index collision | Merge + re-number before final `sources` event |
| Scope helper regression | Same tests as current retrieve ownership |

---

## 13. Explicit non-goals (P1)

- Replacing RAGFlow
- Fast RAG / dual chat modes (removed)
- Full intent taxonomy (chitchat / follow_up / …)
- Chunk/parser presets (P2)
- Golden set + admin retrieval debug (P3)
- Changing multi-tenant / share model

---

## 14. Success criteria

1. Exact-term questions improve with `keyword_search` available.
2. Agent can open a known document via `list_document_chunks` without leaving the chat.
3. All paths still respect UI KB selection and Nest ownership.
4. P0 evidence / rewrite modules remain the single source of truth for formatting and thresholds.

---

## 15. One-line decision

> **P1 builds a routable retrieval tool surface (shared scope + keyword, then list-doc + adjacent expand); chat stays agent-only — no Fast RAG mode.**
