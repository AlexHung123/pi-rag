# RAG Quality P3 Design

**Date:** 2026-07-28  
**Status:** Design (not yet implemented)  
**Product:** CSB Knowledge Base Portal (`pi-rag`)  
**Depends on:** P0 retrieve path (for eval/debug against real params); benefits from P1 tools later  
**Related:**  
- P0 [`2026-07-28-rag-quality-p0.md`](./2026-07-28-rag-quality-p0.md)  
- P1 [`2026-07-28-rag-quality-p1-design.md`](./2026-07-28-rag-quality-p1-design.md)  
- P2 [`2026-07-28-rag-quality-p2-design.md`](./2026-07-28-rag-quality-p2-design.md)  
**Roadmap:** [`2026-07-28-rag-quality-roadmap.md`](./2026-07-28-rag-quality-roadmap.md)  
**Plan checklist:** [`../plans/2026-07-28-rag-quality.md`](../plans/2026-07-28-rag-quality.md)

---

## 1. Goal

P0–P2 change **how we retrieve and ingest**.  
P3 makes those changes **measurable and debuggable**:

1. **Golden set + offline eval** — small fixed questions; Recall@K and empty-hit rates  
2. **Retrieval debug** — per-turn (or last-N) breakdown of query → params → hits  
3. **Observability** — structured logs so “model never called tool” ≠ “tool called, no hit”

**Core idea:** stop tuning `RAG_*` and prompts by gut feel; every change can be compared on the same set and inspected on a failing conversation.

**Non-goals for P3:**

- Full BLEU/ROUGE/nDCG suite or academic IR leaderboard  
- Production A/B experiment platform  
- Replacing Langfuse/Datadog if you add them later — P3 is **minimal in-repo** first  
- Auto-labeling thousands of questions  
- End-user facing “debug mode” (admin/dev only)

---

## 2. Why P3 after (or parallel to) P1/P2

| Without P3 | With P3 |
|------------|---------|
| Raise threshold → “feels better?” | Recall@K before/after on 30 questions |
| User says answer wrong | Debug panel: rewrite? hits? scores? tool count? |
| Agent invents facts | Log: 0 tool calls vs 3 tools empty hits |

P3 can start **as soon as P0 retrieve exists** (eval script only).  
Debug UI is more useful after P1 multi-tool, but can log a single tool first.

---

## 3. Design principles

1. **Small golden set** — 20–50 items beats a perfect schema nobody fills.  
2. **Offline first** — `node apps/api/scripts/eval-retrieve.mjs` against mock or staging; no need for CI GPU.  
3. **Admin/dev only** for debug surfaces — reuse `AdminGuard` / existing admin rail.  
4. **Structured events, not only free-text logs** — one JSON shape for retrieve traces.  
5. **Separate retrieval quality from generation quality** — P3 MVP scores **retrieve**; LLM-as-judge is optional later.  
6. **Privacy** — debug payloads may contain document snippets; restrict to admin, TTL or last-N in memory/Redis, no long-term public store in MVP.

---

## 4. Slice order

```text
P3a  Golden set format + eval-retrieve script     ← first (no UI)
P3b  Structured retrieve logging                   ← with or right after P3a
P3c  In-memory / admin “last retrieval” debug      ← next
P3d  Optional LLM-as-judge / answer groundedness   ← later if needed
```

| Slice | Effort (rough) | Risk |
|-------|----------------|------|
| P3a | 0.5–1.5 days | Low |
| P3b | 0.5 day | Low |
| P3c | 1–2 days | Medium (data retention / auth) |
| P3d | 1+ day | Medium (judge variance) |

**Minimum valuable P3** = **P3a + P3b** (script + logs).  
**Product-visible P3** = add **P3c** admin panel.

---

## 5. P3a — Golden set + offline eval

### 5.1 Dataset format

**Path (proposed):** `testdata/rag-eval/sample.json` (committed, small, no secrets)

```json
{
  "version": 1,
  "description": "Minimal retrieval golden set",
  "cases": [
    {
      "id": "travel-policy-leave",
      "question": "差旅报销需要哪些单据？",
      "knowledgeBaseId": null,
      "ragflowDatasetIds": [],
      "expectedDocumentNames": ["差旅管理制度.pdf"],
      "expectedDocumentIds": [],
      "notes": "Should hit travel policy doc",
      "tags": ["zh", "policy"]
    }
  ]
}
```

**Resolution of scope when running:**

| Mode | How |
|------|-----|
| Staging with env | `EVAL_KB_ID` / `EVAL_DATASET_IDS` override per run |
| Mock | Seed mock store from fixtures, map names → ids in script |
| Case-level | `knowledgeBaseId` or `ragflowDatasetIds` on case if set |

Prefer **document name or id** as expected target for MVP (easier than chunk ids).  
Optional later: `expectedChunkSubstrings: string[]`.

### 5.2 Metrics (MVP)

| Metric | Definition |
|--------|------------|
| **Recall@K** | Fraction of cases where ≥1 expected document appears in top-K hits |
| **Empty-hit rate** | Fraction of cases with 0 hits after threshold (on cases marked `shouldHit: true`, default true) |
| **MRR** (optional) | Mean reciprocal rank of first relevant document |

**Not in MVP:** full answer quality, citation F1, latency SLOs (log latency separately).

### 5.3 Script

**Path (proposed):** `apps/api/scripts/eval-retrieve.mjs`

```text
load sample.json
for each case:
  rewrite? optional flag --rewrite
  call RagflowService.retrieve (or HTTP to local API with service token — prefer direct service via ts-node/nest context if easy)
  compute hit docs
  score
print table + summary JSON to stdout
exit 1 if Recall@K < threshold (optional --fail-under 0.7)
```

**Env:**

```text
RAGFLOW_* / RAGFLOW_MOCK
EVAL_KB_ID=
EVAL_DATASET_IDS=
# reuse RAG_* for fair comparison with production defaults
```

**npm script (optional):**

```json
"eval:retrieve": "node apps/api/scripts/eval-retrieve.mjs"
```

### 5.4 Workflow

1. Change `RAG_SIMILARITY_THRESHOLD` or hybrid weight  
2. Run eval on same golden set  
3. Compare Recall@K / empty-hit  
4. Only then change defaults in `.env.example`

### 5.5 Acceptance (P3a)

- [ ] Committed sample with ≥10 cases (can start with 5 + mock docs)
- [ ] Script runs on `RAGFLOW_MOCK=true` without external deps
- [ ] Prints Recall@K and empty-hit summary
- [ ] Documented how to point at staging datasets

---

## 6. P3b — Structured retrieve logging

### 6.1 Event shape

Emit one structured log (Nest `Logger` JSON-ish or single-line JSON) per retrieve call:

```ts
type RetrieveTrace = {
  ts: string;
  conversationId?: string;
  userId?: string;          // avoid in default logs if privacy-sensitive; hash optional
  tool?: 'retrieve_chunks' | 'keyword_search' | 'list_document_chunks' | 'fast_rag';
  originalQuery?: string;
  rewriteQuery?: string;
  rewritten: boolean;
  datasetIds: string[];
  params: {
    topK: number;
    pageSize: number;
    similarityThreshold: number;
    vectorSimilarityWeight: number;
    rerankId?: string;
  };
  latencyMs: number;
  hitCount: number;
  maxScore: number | null;
  // snippets optional at debug level only
  hitSummary?: Array<{ id: string; documentName?: string; score?: number }>;
};
```

### 6.2 Where to hook

| Call site | Hook |
|-----------|------|
| `RagflowService.retrieve` | Central — always logs params + latency + hitCount (best single place) |
| Agent tools | Add `tool` name + conversation id if available via AsyncLocalStorage or tool deps |
| Query rewrite | Log rewrite latency + rewritten flag (P0 module) |
| Agent turn end | Log `toolCallCount` for retrieval tools (agent.service) |

**Minimum:** instrument `RagflowService.retrieve` + agent tool name when known.

### 6.3 Log levels

| Level | Content |
|-------|---------|
| default `log`/`debug` | counts, scores, latency, params — **no full chunk text** |
| `verbose` / env `RAG_TRACE_SNIPPETS=true` | first 120 chars of each hit |

### 6.4 Acceptance (P3b)

- [ ] One retrieve produces a parseable trace line with hitCount + maxScore + latency
- [ ] Can distinguish empty hits from never-called-tool via agent-level tool count log
- [ ] Snippets off by default

---

## 7. P3c — Retrieval debug (admin / dev)

### 7.1 Storage (MVP)

**In-process ring buffer** keyed by `conversationId` (and optional global last-N):

```ts
// e.g. apps/api/src/rag/retrieve-trace.store.ts
// max 200 conversations × last 10 retrieves; TTL 30–60 min
```

- Multi-instance deploys: debug only sticky to one instance (document limitation) or later Redis  
- **No Postgres table in MVP** unless you already need audit

### 7.2 API

Admin-only (reuse `AdminGuard`):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/retrieval-traces/recent` | Last N global traces |
| GET | `/api/admin/retrieval-traces/by-conversation/:id` | Traces for one chat |

Response: list of `RetrieveTrace` (+ optional hit snippets for admin).

### 7.3 UI

Add under existing **Admin** rail (see admin monitor design):

- Tab or panel: **Retrieval**  
- Table: time, conversation id, query, hitCount, maxScore, latency  
- Detail drawer: params, rewrite, top hits (name, score, snippet)

Non-admin: no nav entry, API 403.

### 7.4 Acceptance (P3c)

- [ ] After a chat with KB, admin can open panel and see last retrieve for that conversation
- [ ] Shows original vs rewrite when rewrite ran
- [ ] Non-admin cannot access endpoint
- [ ] Memory bounded (ring buffer)

---

## 8. P3d — Optional answer groundedness (later)

Only if retrieve metrics look good but users still get hallucinations:

1. For golden cases with short `goldAnswer` or `mustCiteDocuments`  
2. Run fast or agent path  
3. LLM-as-judge: “Does the answer only use provided evidence?” → pass/fail  
4. Keep separate from Recall@K report  

Do **not** block P3a–c on this.

---

## 9. File map (proposed)

| Path | Slice | Action |
|------|-------|--------|
| `testdata/rag-eval/sample.json` | P3a | **New** golden set |
| `apps/api/scripts/eval-retrieve.mjs` | P3a | **New** runner |
| `package.json` / api scripts | P3a | optional `eval:retrieve` |
| `apps/api/src/rag/retrieve-trace.ts` | P3b | types + format helper |
| `apps/api/src/ragflow/ragflow.service.ts` | P3b | emit trace around retrieve |
| `apps/api/src/agent/agent.service.ts` | P3b | tool call counts |
| `apps/api/src/rag/retrieve-trace.store.ts` | P3c | ring buffer |
| `apps/api/src/admin/*` | P3c | endpoints + wire store |
| `apps/web` admin panel | P3c | Retrieval tab |
| `.env.example` | P3b–c | `RAG_TRACE_SNIPPETS`, buffer size |

---

## 10. PR sequence

| PR | Content |
|----|---------|
| **PR-P3a** | sample.json + eval script + README how-to |
| **PR-P3b** | retrieve trace logging |
| **PR-P3c** | store + admin API + UI |
| **PR-P3d** | optional judge (separate) |

---

## 11. Testing plan

### Automated

- Unit: metric helpers (Recall@K, empty rate) on fixture hit lists  
- Script smoke: `RAGFLOW_MOCK=true` eval exits 0 on sample  
- Admin API: non-admin 403; admin 200 with empty list

### Manual

| Case | Expected |
|------|----------|
| Eval on mock corpus | Non-zero Recall if fixtures match questions |
| Raise threshold to 0.99 | Empty-hit rises; script shows drop |
| Chat + selected KB | Admin panel shows hits for that conversation |
| Agent skips tools | toolCallCount 0 in logs; different from hitCount 0 |

---

## 12. Risks

| Risk | Mitigation |
|------|------------|
| Golden set stale vs real KBs | Env overrides; sample uses mock; staging ids in local-only config (not committed secrets) |
| Snippets leak sensitive docs in logs | Default no body text; admin-only debug |
| Multi-instance empty debug | Document sticky sessions; Redis later |
| Eval couples to Nest DI painfully | Prefer thin script calling retrieve HTTP or standalone factory |
| Over-investing in judge | Defer P3d until retrieve is stable |

---

## 13. Relation to other phases

```text
P0 params / evidence / rewrite  ──┐
P1 tools / fast path            ──┼──► P3 measures & explains outcomes
P2 presets / parse health       ──┘
```

| Question | Use |
|----------|-----|
| Did this threshold change help? | P3a eval |
| Why did this chat fail? | P3c debug + P3b logs |
| Is the index bad? | P2 health + then P3a on that KB |
| Wrong tool choice? | P3b tool name + counts (after P1) |

---

## 14. Success criteria

1. A developer can run one command and get Recall@K on a fixed set.  
2. Changing `RAG_*` can be justified with before/after numbers.  
3. On-call/admin can open a conversation and see retrieve params + hits.  
4. Logs separate **no retrieval attempted** vs **retrieval empty**.  
5. No requirement for a heavyweight observability SaaS to get the above.

---

## 15. One-line decision

> **P3 = small golden-set Recall@K + structured retrieve traces + admin last-N debug — make quality work scientific and supportable, not a full ML platform.**
