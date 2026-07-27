# RAG Quality Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve knowledge-base answer quality in pi-rag by fully using RAGFlow retrieval, stronger Nest-side orchestration, better ingest defaults, and a minimal eval loop — without replacing RAGFlow or rewriting the product architecture.

**Architecture:** NestJS owns auth/ownership and agent tools; RAGFlow owns parse/chunk/embed/retrieve; pi-agent-core runs tool-using chat. Optional later **fast RAG** path skips the tool loop for simple QA.

**Tech stack:** NestJS, Prisma, RAGFlow HTTP API, pi-agent-core / pi-ai, existing chat SSE + citations UI.

**Spec / roadmap:** [`../specs/2026-07-28-rag-quality-roadmap.md`](../specs/2026-07-28-rag-quality-roadmap.md)  
**P0 notes:** [`../specs/2026-07-28-rag-quality-p0.md`](../specs/2026-07-28-rag-quality-p0.md)

**Branch:** `feat/rag-quality-p0` (P0 landed); later phases may use `feat/rag-quality-p1` etc.

---

## File map (whole roadmap)

| Path | Phase | Role |
|------|-------|------|
| `apps/api/src/rag/rag-config.ts` | P0 | Env knobs |
| `apps/api/src/rag/evidence.ts` | P0 | Evidence format, dedupe, threshold, citations |
| `apps/api/src/rag/query-rewrite.ts` | P0 | Multi-turn rewrite |
| `apps/api/src/ragflow/ragflow.service.ts` | P0+ | Retrieval (+ later keyword helpers) |
| `apps/api/src/ragflow/ragflow.types.ts` | P0 | `RetrieveOptions` |
| `apps/api/src/agent/agent.tools.ts` | P0 / P1 | Tools + prompts |
| `apps/api/src/agent/agent.service.ts` | P0 / P1 | Rewrite inject; fast path wiring |
| `apps/api/src/chat/*` | P1 | Optional `mode=fast\|agent` |
| `apps/api/src/knowledge/*` + web KB UI | P2 | Chunk presets |
| `apps/api/scripts/eval-retrieve.mjs` | P3 | Golden set runner (new) |
| Admin / debug API + UI | P3 | Retrieval debug |
| `.env.example` | P0+ | Document all `RAG_*` |

---

## Phase P0 — Retrieval quality

**Status:** Done on `feat/rag-quality-p0`

### Task P0.1: Config + retrieve options

- [x] `rag-config.ts` with page size, top_k, threshold, vector weight, rerank, multi-query, rewrite flags
- [x] Extend `RetrieveOptions` / `RagflowService.retrieve` body
- [x] Mock store threshold support
- [x] `.env.example` `RAG_*` vars

### Task P0.2: Evidence + tool path

- [x] `evidence.ts` — format, dedupe, threshold, citation mapping
- [x] `retrieve_chunks` returns structured evidence; details still carry `sources` for UI
- [x] Multi-query resolve + merge

### Task P0.3: Query rewrite

- [x] `query-rewrite.ts` fail-open rewrite via OpenAI-compatible API
- [x] Inject suggested retrieval question when KBs selected
- [x] Update system / selected-KB prompts for citations `[n]`

### Task P0.4: Verify

- [x] `npm run build -w @pi-rag/api`
- [x] Commit + push `feat/rag-quality-p0`

---

## Phase P1 — Orchestration & tools

**Design (how to build):** [`../specs/2026-07-28-rag-quality-p1-design.md`](../specs/2026-07-28-rag-quality-p1-design.md)

Ship order: **P1a → P1b → P1c → P1d(optional)**. Minimum valuable: P1a only.

### Task P1a: Shared scope + keyword_search

- [x] Add `apps/api/src/rag/resolve-scope.ts` (ownership + dataset/doc mapHit)
- [x] Refactor `retrieve_chunks` to use resolve-scope
- [x] Implement `keyword_search`: retrieve with low `vector_similarity_weight` + RAGFlow `keyword: true` (ES)
- [x] Same evidence + `details.sources` contract as P0
- [x] Agent: harvest sources from all retrieval tools (merge/re-index preferred)
- [x] Update `DOMAIN_SYSTEM_PROMPT` routing (semantic vs exact)
- [x] `.env.example`: `RAG_KEYWORD_VECTOR_WEIGHT`, `RAG_KEYWORD_SIMILARITY_THRESHOLD`, `RAG_KEYWORD_ENABLE_ES`
- [x] Build passes (`npm run build -w @pi-rag/api`)

### Task P1b: list_document_chunks tool

- [x] Wrap `RagflowService.listChunks` with app `appDocumentId` → RAGFlow ids
- [x] Pagination + hard pageSize cap + total char budget (~6–8k)
- [x] Prompt: only when document id known from sources / user
- [x] Unauthorized doc fails closed (generic not found message)

### Task P1c: Fast RAG path

- [x] `apps/api/src/rag/fast-rag.service.ts`: rewrite → retrieve → evidence → stream LLM
- [x] Chat DTO/API: optional `mode: 'fast' | 'agent'` (default `agent`)
- [x] SSE: `sources` + text deltas without tool loop
- [x] UI toggle「智能体 / 快速问答」(localStorage)
- [x] Build passes

### Task P1d: Adjacent expand (optional)

- [x] Spike: listChunks document order is stable enough for i−1/i+1
- [x] `expand-hits.ts` shared by retrieve + keyword + fast path
- [x] Env: `RAG_ADJACENT_EXPAND`, `RAG_ADJACENT_EXPAND_MAX_HITS`

---

## Phase P2 — Ingest quality

**Design (how to build):** [`../specs/2026-07-28-rag-quality-p2-design.md`](../specs/2026-07-28-rag-quality-p2-design.md)

Ship order: **P2a → P2b → P2c → P2d**. Minimum valuable: P2a + P2b.  
Can parallel P1; if only one track, prefer P1a before P2 unless bad chunking dominates feedback.

### Task P2a: Preset map + create API

- [ ] Add `apps/api/src/knowledge/chunk-presets.ts` (general/policy/manual/faq → method+config)
- [ ] Validate method names against target RAGFlow; comment tested version
- [ ] `CreateKnowledgeBaseDto.preset?`; resolve order: raw method → preset → general
- [ ] `KnowledgeService.create` uses resolve; optional `GET .../chunk-presets`
- [ ] Build + create smoke per preset

### Task P2b: Create-KB UI

- [ ] Preset picker (business labels); default `general`
- [ ] Optional collapsed advanced raw method/config
- [ ] Wire `api.createKnowledgeBase({ preset })`

### Task P2c: Parse health

- [ ] `apps/api/src/documents/parse-health.ts` heuristics (size vs chunkCount, empty sample)
- [ ] Attach `health` on document serialize / after refresh `done`
- [ ] Web (and/or admin) badge + tooltip; never block preview
- [ ] Build + smoke done+0 chunks → warn/bad

### Task P2d: Operator docs

- [ ] README or superpowers: when to use which preset; create-time only; vs `RAG_*`
- [ ] Link from roadmap/plan

---

## Phase P3 — Eval & debug

**Design (how to build):** [`../specs/2026-07-28-rag-quality-p3-design.md`](../specs/2026-07-28-rag-quality-p3-design.md)

Ship order: **P3a → P3b → P3c → P3d(optional)**. Minimum valuable: P3a + P3b.  
Can start P3a as soon as P0 retrieve exists (independent of P1/P2 UI).

### Task P3a: Golden set + eval script

- [ ] Add `testdata/rag-eval/sample.json` (≥5–10 cases; target 20–50)
- [ ] `apps/api/scripts/eval-retrieve.mjs`: retrieve each case; print Recall@K + empty-hit
- [ ] Support `RAGFLOW_MOCK=true` and staging dataset/KB env overrides
- [ ] Optional npm script `eval:retrieve`; docs how-to

### Task P3b: Structured retrieve logging

- [ ] `RetrieveTrace` type + format helper
- [ ] Instrument `RagflowService.retrieve` (latency, hitCount, maxScore, params)
- [ ] Agent: log retrieval tool call counts per turn
- [ ] Snippets off by default (`RAG_TRACE_SNIPPETS`)

### Task P3c: Admin retrieval debug

- [ ] In-memory ring buffer store (bounded, TTL)
- [ ] Admin API: recent + by conversationId
- [ ] Admin UI panel: query / rewrite / params / hits
- [ ] Non-admin 403; no chunk bodies in default list view

### Task P3d: Optional groundedness judge

- [ ] Only if retrieve metrics OK but answers still hallucinate
- [ ] Separate report from Recall@K

---

## Out of scope (do not implement under this plan)

- [ ] Replace RAGFlow with in-house vector stack
- [ ] GraphRAG / Wiki generation
- [ ] Per-user RAGFlow API keys
- [ ] Full WeKnora chat_pipeline plugin framework

---

## Suggested PR sequence

| PR | Content |
|----|---------|
| PR1 | P0 (this branch) — retrieval + evidence + rewrite |
| PR2 | P1 tools (keyword + list) |
| PR3 | P1 fast path |
| PR4 | P2 presets + parse health |
| PR5 | P3 eval + debug |

---

## Quick verification commands

```bash
cd D:\Coding\pi-rag
npm run build -w @pi-rag/api
# after P3:
# node apps/api/scripts/eval-retrieve.mjs
```
