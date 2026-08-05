# RAG Quality Roadmap

**Date:** 2026-07-28  
**Status:** Active  
**Product:** CSB Knowledge Base Portal (`pi-rag`)  
**Branch (P0):** `feat/rag-quality-p0`  
**Implementation plan:** [`../plans/2026-07-28-rag-quality.md`](../plans/2026-07-28-rag-quality.md)  
**P0 detail:** [`./2026-07-28-rag-quality-p0.md`](./2026-07-28-rag-quality-p0.md)

---

## 1. Context

### 1.1 Architecture (locked)

```text
Browser → NestJS (auth, ownership) → RAGFlow (parse / chunk / embed / retrieve)
                                   → pi-agent-core (tools + LLM)
```

- **RAGFlow** remains the knowledge engine (do not reimplement vector DB / parsers).
- **NestJS** is the only public API; agent tools bind `userId` and never invent KB ids.
- Improvements should **use RAGFlow APIs fully** and add orchestration in Nest + agent layer.

### 1.2 Baseline gaps (pre-P0)

| Area | Before |
|------|--------|
| Retrieval API | Only `question`, `dataset_ids`, `top_k` / `page_size` |
| Agent tools | Single `retrieve_chunks`; raw JSON dump to model |
| Query understanding | Prompt-only; no rewrite |
| Multi-query | No |
| Keyword / exact match tool | No |
| Fast non-agent RAG path | No (agent-only QA) |
| Ingest presets | `chunk_method` default `naive`; little product guidance |
| Eval / debug | Explicit non-goals in MVP; still needed for quality loops |

### 1.3 Reference (WeKnora — steal ideas, not the stack)

| WeKnora pattern | How we apply it in pi-rag |
|-----------------|---------------------------|
| Hybrid + over-retrieve + rerank | RAGFlow retrieval body + env knobs |
| Query rewrite + intent | Nest rewrite + later light intent |
| RRF / multi-retriever | Multi-query merge; keyword tool as second path |
| Structured context template | Evidence formatter with `[n]` citations |
| Parent-child / expand | Optional adjacent-chunk expand if API allows |
| Classic RAG + Agent dual mode | **Not adopted** — agent-only chat |
| Metric suite | Minimal golden set + Recall@K |

**Do not port:** multi-engine vector stores, Wiki auto-generation, full GraphRAG, heavy RBAC.

---

## 2. Principles

1. **RAGFlow-first** — prefer engine features over custom indexes.
2. **Evidence-bound answers** — model must prefer tool evidence; refuse when empty/weak.
3. **Measurable** — change retrieval knobs only with a small eval set after P0.
4. **Incremental** — P0 already shipped; later phases stay shippable alone.
5. **Isolation unchanged** — ownership / share / public rules stay on Nest services.

---

## 3. Phases overview

| Phase | Theme | Status |
|-------|--------|--------|
| **P0** | Retrieval params, evidence format, threshold, multi-query, rewrite | **Done** (`feat/rag-quality-p0`) |
| **P1** | Tool split (keyword/list), stronger orchestration; **no Fast RAG** | In progress / agent-only |
| **P2** | Ingest quality (chunk presets, parse health) | Planned |
| **P3** | Eval set, retrieval debug, observability | Planned |

### Related track (not a RAGFlow retrieval phase)

| Track | Theme | Spec |
|-------|--------|------|
| **Workspace + Analyze** | Session scratch workspace; materialize/query tables; routing for 最/统计/排名 | [`2026-08-06-session-workspace-analyze-design.md`](./2026-08-06-session-workspace-analyze-design.md) · [plan](../plans/2026-08-06-session-workspace-analyze.md) |

This track complements P0–P3: retrieval stays for prose/lookup; analyze tools cover global aggregates that top-k chunks cannot compute.

Suggested cadence (flexible):

```text
P0  (done)   hybrid + evidence + rewrite
P1  (~1–2w)  tools (keyword/list/expand); agent-only
P2  (~1w)    chunk presets + parse health
P3  (~1w)    golden set + debug panel
Analyze P1   session workspace + xlsx/csv query_table (parallel when ready)
```

---

## 4. P0 — Retrieval quality (done)

### Goals

1. Over-retrieve (`top_k`) + return page (`page_size`)
2. Hybrid weight + similarity threshold + optional `rerank_id`
3. Structured evidence text + score filter for the agent
4. Multi-query merge/dedupe
5. Multi-turn query rewrite hint when KBs are selected

### Delivered code

| Path | Role |
|------|------|
| `apps/api/src/rag/rag-config.ts` | Env defaults |
| `apps/api/src/rag/evidence.ts` | Format / dedupe / threshold / citations |
| `apps/api/src/rag/query-rewrite.ts` | OpenAI-compatible rewrite |
| `apps/api/src/ragflow/ragflow.service.ts` | Full retrieval body |
| `apps/api/src/agent/agent.tools.ts` | Evidence path for `retrieve_chunks` |
| `apps/api/src/agent/agent.service.ts` | Rewrite hint injection |
| `.env.example` | `RAG_*` knobs |

### Env knobs

| Variable | Default | Meaning |
|----------|---------|---------|
| `RAG_PAGE_SIZE` | 10 | Chunks returned to agent |
| `RAG_TOP_K` | 30 | RAGFlow candidate pool |
| `RAG_SIMILARITY_THRESHOLD` | 0.2 | Min similarity |
| `RAG_VECTOR_SIMILARITY_WEIGHT` | 0.7 | Vector vs keyword mix |
| `RAG_RERANK_ID` | empty | RAGFlow rerank model id |
| `RAG_MAX_CHUNK_CHARS` | 1200 | Tool text truncation |
| `RAG_MULTI_QUERY` | true | Multi-query enable |
| `RAG_MULTI_QUERY_MAX` | 3 | Max queries per call |
| `RAG_QUERY_REWRITE` | true | Multi-turn rewrite |

### Acceptance (P0)

- [x] Real RAGFlow retrieve sends threshold / weight / over-retrieve
- [x] Mock retrieve respects threshold
- [x] Tool content is evidence blocks with `[n]`, not only raw JSON array
- [x] Empty / weak hits instruct refuse-to-invent
- [x] Selected-KB turns can inject rewritten search question
- [x] `npm run build -w @pi-rag/api` passes

---

## 5. P1 — Orchestration & tools

**Detailed design:** [`./2026-07-28-rag-quality-p1-design.md`](./2026-07-28-rag-quality-p1-design.md)

### Goals

Make retrieval **multi-legged** (semantic + keyword + document browse). Chat remains agent-only.

### Recommended slice order

| Slice | Content | Priority |
|-------|---------|----------|
| **P1a** | Shared `resolveRetrievalScope` + `keyword_search` | **First** (highest ROI) |
| **P1b** | `list_document_chunks` | After P1a |
| **P1c** | Fast RAG `mode=fast\|agent` | **Removed** (not needed) |
| **P1d** | Adjacent-chunk expand | Optional; skip if API weak |

### 5.1 Tool split

| Tool | Purpose | Notes |
|------|---------|--------|
| `retrieve_chunks` | Semantic / hybrid (exists) | Keep as primary |
| `keyword_search` | Literal terms, codes, names | Same retrieve API, low `vector_similarity_weight` |
| `list_document_chunks` | Browse chunks of one doc | Wrap existing `listChunks`; app document UUID only |

Agent prompt: conceptual Q → retrieve; exact entity/code → keyword; known doc → list.

### 5.2 Classic fast RAG path — **removed**

Product decision: no `mode=fast` / dual chat mode. All QA uses the agent tool loop.

### 5.3 Context / citation hardening

- Harvest `details.sources` from all retrieval tools; merge + re-index when multi-tool.
- Align UI `CitationSource.index` with answer `[n]`.

### 5.4 Adjacent context expand (if RAGFlow supports)

- On hit, attach i−1 / i+1 when order is stable; else document skip (P1d).

### Acceptance (P1)

- [ ] At least one non-semantic retrieval tool usable by agent (P1a)
- [ ] Shared scope helper (no duplicated ownership) (P1a)
- [ ] List-doc tool with char budget (P1b)
- [ ] ~~Fast path~~ removed — agent-only chat
- [ ] Prompt documents when to use which tool
- [ ] Build passes; manual smoke on mock + real RAGFlow

---

## 6. P2 — Ingest quality

**Detailed design:** [`./2026-07-28-rag-quality-p2-design.md`](./2026-07-28-rag-quality-p2-design.md)

### Goals

Raise **recall ceiling** by better chunking defaults, not only query-time knobs.

### Recommended slice order

| Slice | Content | Priority |
|-------|---------|----------|
| **P2a** | Preset map + create KB `preset` | **First** |
| **P2b** | Create-KB UI preset picker | With / right after P2a |
| **P2c** | Parse health after `done` + list badges | Next |
| **P2d** | Operator docs | Anytime |

### 6.1 Chunk / parser presets

| Preset | Typical use | Direction |
|--------|-------------|-----------|
| `general` | Mixed docs | `naive` + balanced chunk size/overlap |
| `policy` | Regulations / 制度 | `laws` (or closest on target RAGFlow) |
| `manual` | Product manuals / structured docs | Heading-friendly method if available |
| `faq` | Q&A pairs | Smaller chunks, overlap ≈ 0 |

- Server map is source of truth; store on `chunk_method` + `parser_config` (schema already exists).
- UI: business labels, not raw engine strings. **Create-time only** in MVP.

### 6.2 Parse health checks

After parse `done`:

- chunk_count too low vs file size → warn
- zero chunks while done → bad
- average length extremes / empty sample ratio → warn

Surface in document list or admin monitor; do not block preview.

### 6.3 Optional enrichment (not MVP)

- Document-level summary as extra searchable text
- Rely on RAGFlow auto-keywords when present

### Acceptance (P2)

- [ ] ≥3 presets create dataset with distinct method/config (P2a)
- [ ] UI can select preset without typing method (P2b)
- [ ] Parse health warnings visible for pathological docs (P2c)
- [ ] Operator docs: preset vs `RAG_*` query knobs (P2d)

---

## 7. P3 — Eval, debug, observability

**Detailed design:** [`./2026-07-28-rag-quality-p3-design.md`](./2026-07-28-rag-quality-p3-design.md)

### Goals

Make quality changes **regression-safe** and failures **explainable**.

### Recommended slice order

| Slice | Content | Priority |
|-------|---------|----------|
| **P3a** | Golden set + `eval-retrieve` script | **First** (no UI) |
| **P3b** | Structured retrieve logging | With / after P3a |
| **P3c** | Admin last-N retrieval debug API + UI | Next |
| **P3d** | Optional LLM-as-judge groundedness | Later |

### 7.1 Golden set (minimal)

- 20–50 items: `{ question, expectedDocumentNames/ids, notes }`
- Metrics: **Recall@K**, **empty-hit rate** (optional MRR)
- Script: `apps/api/scripts/eval-retrieve.mjs` on mock or staging
- Score **retrieval** first; answer quality judge is P3d

### 7.2 Retrieval debug (admin or dev-only)

Per request / last-N (ring buffer):

- original query, rewrite query  
- params (threshold, weight, top_k, page_size)  
- hits: score, document, optional snippet  

Admin rail panel; `AdminGuard`; no long-term public store in MVP.

### 7.3 Logging / metrics

Hook `RagflowService.retrieve` (+ agent tool counts):

- retrieve latency, hit count, max score  
- tool name / call count (separate “never retrieved” vs “empty hits”)  
- rewrite on/off and latency  
- snippets only with explicit env flag  

### Acceptance (P3)

- [ ] Golden set runnable offline against mock or staging (P3a)
- [ ] Structured retrieve trace in logs (P3b)
- [ ] Admin can inspect last retrieve for a conversation (P3c)
- [ ] Can separate “no tool call” vs “tool call, no hit”

---

## 8. Explicit non-goals (near term)

- Replacing RAGFlow with in-process pgvector / ES
- Full GraphRAG / Wiki agent generation (unless product asks)
- Per-user RAGFlow API keys
- Matching WeKnora pipeline plugin bus 1:1

---

## 9. Risk notes

| Risk | Mitigation |
|------|------------|
| RAGFlow field names differ by version | Map defensively; document tested RAGFlow version |
| Rewrite adds latency | Short timeout; fail open to original query (P0 behavior) |
| Multi-query multiplies cost | Cap `RAG_MULTI_QUERY_MAX`; disable via env |
| Fast path vs agent product confusion | Clear UI label; default documented |
| Over-filtering with high threshold | Keep default 0.2; tune with golden set |

---

## 10. Success criteria (overall)

1. Factual answers on selected KBs cite real documents more often and invent less.
2. Multi-turn “it / 上面” questions retrieve the right topic after rewrite.
3. Exact-term questions improve once keyword tool exists (P1).
4. Changing `RAG_*` can be justified with golden-set numbers (P3).
5. Architecture stays: Nest boundary + RAGFlow engine + optional agent.

---

## 11. Related docs

| Doc | Role |
|-----|------|
| [`2026-07-23-pi-rag-design.md`](./2026-07-23-pi-rag-design.md) | Product MVP architecture |
| [`2026-07-24-pi-agent-pool-design.md`](./2026-07-24-pi-agent-pool-design.md) | Agent pool |
| [`2026-07-28-rag-quality-p0.md`](./2026-07-28-rag-quality-p0.md) | P0 shipped detail |
| [`2026-07-28-rag-quality-p1-design.md`](./2026-07-28-rag-quality-p1-design.md) | P1 tools design (agent-only; no Fast RAG) |
| [`2026-07-28-rag-quality-p2-design.md`](./2026-07-28-rag-quality-p2-design.md) | P2 ingest presets + parse health design |
| [`2026-07-28-rag-quality-p3-design.md`](./2026-07-28-rag-quality-p3-design.md) | P3 eval + debug + observability design |
| [`../plans/2026-07-28-rag-quality.md`](../plans/2026-07-28-rag-quality.md) | Task checklist for agents |
