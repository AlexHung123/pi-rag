# Session Workspace + Analyze Tools Design

**Date:** 2026-08-06  
**Status:** Draft (ready for implementation planning)  
**Product:** CSB Knowledge Base Portal (`pi-rag`)  
**Depends on:** Agent tools ([`2026-07-23-pi-rag-design.md`](./2026-07-23-pi-rag-design.md)), pool ([`2026-07-24-pi-agent-pool-design.md`](./2026-07-24-pi-agent-pool-design.md)), RAG quality P0/P1 ([`2026-07-28-rag-quality-roadmap.md`](./2026-07-28-rag-quality-roadmap.md)), compaction ([`2026-08-03-agent-compaction-design.md`](./2026-08-03-agent-compaction-design.md))  
**Plan checklist:** [`../plans/2026-08-06-session-workspace-analyze.md`](../plans/2026-08-06-session-workspace-analyze.md)

---

## 1. Goal

Extend the existing **agent-only** chat path so the model can solve problems that **chunk retrieval cannot** (global rank, count, trend, compare), without becoming an open-ended “computer-use” agent.

### 1.1 Outcomes

1. **Session workspace** — thin, per-conversation scratch space for authorized inputs, derived tables, and analysis artifacts.
2. **Analyze tools** — inspect → materialize → query (and later sandboxed code) over knowledge-scoped data.
3. **Routing** — system prompt + tool descriptions steer aggregate questions away from pure `retrieve_chunks`.
4. **Same security model** — Nest ownership / share / document scope; no new public RAGFlow surface.

### 1.2 Non-goals (this design)

| Out of scope | Why |
|--------------|-----|
| Full IDE / project workspace (Cursor-like) | Product is a KB portal; cost and isolation explode |
| Arbitrary shell, network, package install | Security |
| Replacing RAGFlow parse/embed/retrieve | Architecture locked: RAGFlow-first |
| Second chat product (“general mode” fork) | One agent runtime, more tools |
| GraphRAG / Wiki auto-generation | Separate tracks |
| Guaranteed perfect PDF table extraction in Phase 1 | Phase 1 = Excel/CSV (+ optional Markdown tables); PDF later |

---

## 2. Problem statement

### 2.1 What works today

| Capability | Tools |
|------------|--------|
| Semantic / hybrid lookup | `retrieve_chunks` |
| Exact terms / names / titles | `keyword_search` |
| Whole-document textual summary | `summarize_document` |
| Personal memory | `profile_*` / `memory_*` |

### 2.2 What fails

Example: *「总结最悠久的员工」* on a large job-change spreadsheet or 1000-page table PDF.

| Approach | Failure mode |
|----------|----------------|
| `retrieve_chunks` / `keyword_search` | Similarity ≠ global `argmax(tenure)` |
| One giant chunk | Embedding truncation; noise; lost-in-the-middle |
| `summarize_document` full stitch | Budget clip; model still weak at exact rank over huge tables |
| Pure LLM “read everything in prompt” | Only works if cleaned text fits; not a product retrieval strategy |

Correct shape:

```text
authorized document(s)
  → structured table (rows)
  → aggregate / sort / top-N  (deterministic)
  → LLM summarizes the small result (+ optional row evidence via retrieval)
```

### 2.3 Product positioning

**Knowledge Problem-Solving Agent** (not “general OS agent”):

- Still answers policies, notes, and point lookups via RAG.
- Can **compute** over user-selected knowledge when the question needs the whole table or corpus slice.
- Workspace is a **scratchpad for tools**, not a user-facing IDE by default.

---

## 3. Design principles

1. **RAGFlow-first for knowledge storage** — do not reimplement vector DB; may download original files / list chunks via existing Nest→RAGFlow client.
2. **Deterministic compute for extremes** — min/max/count/rank run in Nest (or sandbox), not “guessed” from top-k chunks.
3. **Thin session workspace** — TTL-backed artifacts; path sandbox; tied to `userId` + `conversationId`.
4. **Same evidence contract where possible** — tools return `content[].text` for the model; `details.sources` / artifacts for UI.
5. **Incremental phases** — ship table query before code sandbox before heavy UI.
6. **Isolation unchanged** — every document touch goes through `resolveRetrievalScope` / `resolveDocumentScope` (or equivalent).

---

## 4. Architecture

```text
Browser
  │
  ▼
NestJS (auth, ownership, agent pool)
  │
  ├─► RAGFlow          parse / chunk / embed / retrieve / file download
  ├─► Postgres         ownership + NEW workspace / artifact metadata
  ├─► Workspace store  disk or object dir: inputs/, derived/, notes
  └─► pi-agent-core    tools: retrieval (existing) + analyze (new)
         │
         └─► (Phase 3) optional sandbox worker — read-only mount of one workspace
```

### 4.1 Relationship to existing agent

| Piece | Change |
|-------|--------|
| `AgentService` / pool | Inject analyze + workspace services into `createUserTools` |
| `createUserTools` | Register new tools; extend `DOMAIN_SYSTEM_PROMPT` |
| `AgentRunToolGuard` | Separate budgets for analyze tools if needed |
| `tool-summary.ts` | User-visible summaries for materialize/query |
| `extract-sources` | Citation type for “analysis result + source document” |
| Compaction | Large query results must be clipped / artifact-referenced (see §8) |

### 4.2 Workspace lifecycle

```text
conversation created / first analyze tool
  → ensure SessionWorkspace (userId, conversationId)

tool materialize_table / write artifact
  → files under workspace root + Artifact rows

conversation deleted / TTL job
  → delete DB rows + files

agent disposeConversation
  → optional eager cleanup or leave to TTL
```

**Binding:** one workspace per `(userId, conversationId)` (1:1 with chat session).  
No cross-conversation sharing in Phase 1–2.

---

## 5. Session workspace (thin)

### 5.1 Layout (server-side)

```text
{WORKSPACE_ROOT}/{userId}/{conversationId}/
  manifest.json          # ids, hashes, schema versions
  inputs/                # exported authorized sources (optional cache)
    {documentId}.xlsx
    {documentId}.csv
  derived/               # materializations & query outputs
    {artifactId}.parquet # or .csv / .jsonl
    {artifactId}.meta.json
  notes/                 # optional short agent notes (Phase 2+)
    plan.md
```

`WORKSPACE_ROOT` from env (e.g. `PI_RAG_WORKSPACE_ROOT`). Default under API data dir, **not** web-accessible.

### 5.2 Data model (Prisma sketch)

```prisma
model SessionWorkspace {
  id             String   @id @default(uuid()) @db.Uuid
  userId         String   @map("user_id") @db.Uuid
  conversationId String   @unique @map("conversation_id") @db.Uuid
  rootPath       String   @map("root_path")  // relative key under WORKSPACE_ROOT
  expiresAt      DateTime @map("expires_at")
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  user         User         @relation(...)
  conversation Conversation @relation(...)
  artifacts    WorkspaceArtifact[]

  @@index([userId])
  @@index([expiresAt])
  @@map("session_workspaces")
}

enum WorkspaceArtifactKind {
  source_export
  table
  query_result
  note
  other
}

model WorkspaceArtifact {
  id          String                @id @default(uuid()) @db.Uuid
  workspaceId String                @map("workspace_id") @db.Uuid
  kind        WorkspaceArtifactKind
  name        String                // display name
  relPath     String                @map("rel_path") // under workspace root
  /// e.g. column schema, rowCount, sourceDocumentIds, contentHash
  meta        Json                  @default("{}")
  byteSize    BigInt                @default(0) @map("byte_size")
  createdAt   DateTime              @default(now()) @map("created_at")

  workspace SessionWorkspace @relation(...)

  @@index([workspaceId])
  @@map("workspace_artifacts")
}
```

Wire `Conversation` / `User` relations with `onDelete: Cascade` from conversation (and user).

### 5.3 Limits (env knobs)

| Env | Default (suggested) | Meaning |
|-----|---------------------|---------|
| `WORKSPACE_TTL_HOURS` | `168` (7d) | Expire unused workspaces |
| `WORKSPACE_MAX_BYTES_PER_CONV` | `512MiB` | Hard cap per conversation |
| `WORKSPACE_MAX_ARTIFACTS` | `50` | Cap artifact count |
| `ANALYZE_MAX_ROWS_MATERIALIZE` | `200000` | Reject or sample above |
| `ANALYZE_MAX_RESULT_ROWS` | `500` | Max rows returned inline to model |
| `ANALYZE_MAX_RESULT_CHARS` | align with compaction | Clip tool payload |
| `ANALYZE_ENABLED` | `true` | Feature flag |

### 5.4 Path safety

- All reads/writes resolve under workspace root; reject `..` and absolute paths from the model.
- Artifact ids are UUIDs; model never supplies raw filesystem paths (only `artifactId` / `name` hints resolved server-side).

---

## 6. Analyze tools

### 6.1 Tool inventory by phase

| Phase | Tool | Purpose |
|-------|------|---------|
| **1** | `inspect_document` | Type, size, chunk count, “looks tabular?”, sample columns / head rows |
| **1** | `materialize_table` | Build a queryable table artifact from a scoped document |
| **1** | `query_table` | Filter / group / aggregate / sort / limit on an artifact |
| **1** | `list_artifacts` | List workspace tables/results for this conversation |
| **2** | `read_artifact` | Read clipped preview of an artifact (schema + head) |
| **2** | UI: “Analysis artifacts” panel (optional) | Download CSV of query_result |
| **3** | `run_analysis_code` | Sandboxed pandas on mounted workspace (read-mostly) |

Keep existing retrieval tools unchanged in semantics.

### 6.2 `inspect_document`

**When:** Before materialize; or when user asks what a file contains.

**Params (sketch):**

```ts
{
  knowledgeBaseIds: string[];      // UI selection; server may override from turnContext
  appDocumentId?: string;
  documentNameHint?: string;
}
```

**Server:**

1. `resolveRetrievalScope` / `resolveDocumentScope`.
2. Load portal `Document` row (name, size, status, source type).
3. Optional: download file header / first N KB; or sample RAGFlow chunks.
4. Heuristics: extension, delimiter, markdown table fences, RAGFlow `chunk_method` if stored.

**Returns (text):** human-readable summary + JSON-ish schema guess.  
**details:** `{ path: 'inspect', appDocumentId, documentName, looksTabular, columns?, sampleRows?, sources }`.

### 6.3 `materialize_table`

**When:** Aggregate / rank / count questions over tabular data; after inspect if needed.

**Params:**

```ts
{
  knowledgeBaseIds: string[];
  appDocumentId?: string;
  documentNameHint?: string;
  /** Prefer sheet name for xlsx */
  sheetName?: string;
  /** Optional header row index (0-based) */
  headerRow?: number;
  /** Force re-build even if contentHash cache hits */
  force?: boolean;
}
```

**Supported sources (Phase 1):**

| Source | Method |
|--------|--------|
| `.xlsx` / `.xls` | Parse with a maintained library (e.g. SheetJS/exceljs) from downloaded original |
| `.csv` / `.tsv` / `.txt` (delimited) | Parse with delimiter sniff |
| Markdown tables in chunks | Best-effort: extract pipe tables from ordered `listChunks` (optional stretch in P1) |

**Phase 2+:** PDF/MinerU cleaned tables — separate extractor pipeline; store as CSV in `inputs/` then same materialize path.

**Caching:**  
`contentHash = hash(ragflow doc update time || file etag || portal updatedAt) + parser version + sheetName`.  
If artifact exists with same hash → return existing `artifactId`.

**Storage format:** prefer **CSV or Parquet** in `derived/`; `meta` holds:

```json
{
  "columns": [{"name": "姓名", "type": "string|number|date|bool|unknown"}],
  "rowCount": 12345,
  "sourceDocumentIds": ["..."],
  "contentHash": "...",
  "parser": "xlsx@1"
}
```

**Returns:** artifact id, schema, rowCount, head(5).  
On failure: clear error (`not tabular`, `too many rows`, `download failed`).

### 6.4 `query_table`

**When:** Rankings, counts, filters, group-bys. **Preferred over retrieve for 最/多少/平均/趋势.**

**Do not accept raw SQL strings in Phase 1.** Use a **whitelist AST** executed server-side (SQL generation internal only).

**Params (sketch):**

```ts
{
  artifactId: string;
  /**
   * select: column names or aggregations
   * e.g. ["工号", "姓名", { "op": "min", "col": "生效日期", "as": "earliest" }]
   */
  select?: Array<string | Agg>;
  /** equality / in / gte / lte / contains on columns */
  where?: Filter[];
  groupBy?: string[];
  orderBy?: Array<{ col: string; dir: "asc" | "desc" }>;
  limit?: number;  // default 20, max ANALYZE_MAX_RESULT_ROWS
  /**
   * Convenience presets for common HR/table questions (optional sugar)
   * e.g. "tenure_top" with dateColumn + idColumns
   */
  preset?: {
    name: "tenure_top" | "value_counts" | "describe";
    dateColumn?: string;
    idColumns?: string[];  // e.g. ["工号","姓名"]
    topN?: number;
  };
}
```

**Preset `tenure_top` (motivating example):**

```text
group by idColumns
  earliest = min(dateColumn)
  tenureDays = asOf - earliest
order by tenureDays desc
limit topN
```

Document **口径** in the tool return text so the model states assumptions (e.g. “earliest row in this table, not HR hire date”).

**Execution:** Nest service loads artifact → DuckDB/SQLite/polars/pandas in-process for Phase 1 (pick one; **DuckDB or better-sqlite-sql.js** are fine). Phase 3 may move heavy jobs to worker.

**Returns (text for model):**

```text
Analysis result (deterministic)
口径: ...
artifact: <id> (source: 职位变动表.xlsx)
rows: <n>

| 姓名 | 工号 | earliest | tenure_years |
| ...

(If truncated, full result artifactId=... ; showing first N rows)
```

**details:**

```ts
{
  path: 'query_table',
  artifactId,
  resultArtifactId?,
  sources: CitationSource[],  // source documents
  rowCount,
  truncated: boolean,
}
```

### 6.5 `list_artifacts` / `read_artifact`

- `list_artifacts`: id, kind, name, rowCount, createdAt.  
- `read_artifact`: schema + head/tail clipped; never dump 200k rows into the model.

---

## 7. Agent routing (prompt)

Extend `DOMAIN_SYSTEM_PROMPT` (and selected-KB prefix) with an **Analyze** section:

```text
Analyze tools (when knowledge bases are selected and ANALYZE is enabled):
- inspect_document — file shape, columns, whether tabular
- materialize_table — build a queryable table from Excel/CSV (and later MD/PDF tables)
- query_table — filter/aggregate/sort/Top-N; use for 最/最多/最少/多少/平均/排名/趋势/统计
- list_artifacts — tables already built in this conversation

Routing:
- Point lookup in prose policies / meeting notes → retrieve_chunks / keyword_search
- Whole-document prose summary → summarize_document
- Global stats / rankings / “最悠久” / counts over a table → inspect (if needed) → materialize_table → query_table
  Do NOT answer global extrema using only retrieve_chunks evidence
- Hybrid: compute Top-N with query_table, then optional keyword_search for narrative evidence on those people

Never invent spreadsheet rows. If materialize/query fails, say what failed and ask for Excel/CSV if PDF cannot be parsed yet.
```

Intent heuristic (optional Nest pre-hint, Phase 1b):

| Signal in user message | `suggestedPath` |
|------------------------|-----------------|
| 最、最多、最少、排名、top、多少、共有、平均、趋势、统计、占比 | `analyze` |
| 总结整份、全文摘要、summarize this document | `summarize` |
| else factual | `retrieve` |

Inject one line into the turn prefix: `Suggested path: analyze` — model may override with reason.

---

## 8. Context budget & compaction

Analyze tool results can be large.

Rules:

1. Inline to the model: **≤ `ANALYZE_MAX_RESULT_ROWS`** and **≤ tool result char budget** (reuse `getMaxToolResultChars` / compaction settings).
2. Overflow → write `query_result` artifact; tool text says “full result in artifact X; preview below”.
3. Mid-run compaction must **not** drop the only copy of schema/口径 without leaving artifact id.
4. `summarize_document` remains for prose; do not pipe 400k-token markdown tables through it when `looksTabular` — prompt should prefer materialize.

---

## 9. Citations & UI

### 9.1 Sources

For analyze tools:

- Always attach **source document** citation(s) (portal doc id, name, KB).
- Optionally attach a synthetic source: `kind: 'analysis'`, title like `分析: tenure_top on 职位变动表.xlsx`.

UI can show analysis sources differently (e.g. “计算结果” badge) but may reuse `CitationSource` with an extra field if needed:

```ts
// extension (backward compatible)
sourceKind?: 'chunk' | 'document' | 'analysis';
```

### 9.2 SSE / tool_end

`tool-summary.ts`:

- `materialize_table` → `Built table (12,345 rows, 8 cols) from 职位变动.xlsx`
- `query_table` → `Query returned 10 rows (tenure_top)`

### 9.3 Frontend (Phase 2)

Minimal:

- Collapsible “Artifacts” in chat or side panel when `list_artifacts` non-empty.
- Download CSV for `query_result` / `table` via Nest API `GET /conversations/:id/artifacts/:id/download` (authz).

Phase 1 may be **agent-only** (no new UI) if summaries in tool_end are enough.

---

## 10. Security

| Control | Rule |
|---------|------|
| Authz | Same as retrieval: selected KBs + document filter + ownership/share |
| Path | UUID artifacts only; chroot under workspace root |
| Query | Whitelist AST; no multi-statement SQL from model |
| Size | Row/byte caps; reject huge materialize with actionable error |
| PII | Workspace inherits document sensitivity; TTL delete |
| Audit | Log userId, conversationId, documentIds, tool name, row counts (no full PII dumps in logs) |
| Sandbox (P3) | No network; read workspace; write only `derived/`; CPU/memory/time limits |

---

## 11. Phased delivery

### Phase 1 — Table solver MVP (target: 1–2 weeks)

- Prisma models + migration  
- Workspace service (ensure, path, TTL cleanup job or lazy expire)  
- Tools: `inspect_document`, `materialize_table` (xlsx/csv), `query_table` (+ `tenure_top` preset), `list_artifacts`  
- Prompt routing  
- tool-summary + sources  
- Feature flag `ANALYZE_ENABLED`  
- Unit tests: tenure_top on fixture CSV; path traversal rejected; scope denied  

**Success criteria:** Fixed eval question *「总结最悠久的员工」* on a fixture spreadsheet returns correct Top-N names via `query_table`, not via retrieve-only.

### Phase 2 — Workspace UX + more sources

- `read_artifact`  
- Download API + light UI  
- Markdown table materialize from chunks  
- Better column type inference / date parsing  
- Intent pre-hint in Nest  

### Phase 3 — Sandboxed code

- `run_analysis_code` worker  
- Mount single workspace read-only (+ write derived)  
- Stricter run limits  

### Phase 4 — PDF / MinerU tables (optional track)

- Ingest or on-demand: clean symbols → row CSV in `inputs/`  
- Same `materialize_table` / `query_table`  
- Still no “one 400k chunk” strategy for ranking  

---

## 12. Eval set (minimum)

Add under `testdata/analyze/` (or extend rag-eval):

| # | Question type | Fixture | Expect path | Expect |
|---|----------------|---------|-------------|--------|
| 1 | tenure top | `hr_moves.csv` | materialize + query | Correct person as #1 |
| 2 | count by dept | same | query groupBy | Matches pandas gold |
| 3 | policy point lookup | prose md | retrieve/keyword | No materialize required |
| 4 | whole-doc summary | short md | summarize_document | No query_table |
| 5 | hybrid | hr + policy | query then retrieve | Top person + cites policy if asked |
| 6 | no KB selected | — | no analyze | Ask to select KB |
| 7 | doc not owned | — | 404-style tool message | No leak |
| 8 | non-tabular pdf (P1) | scan stub | inspect/materialize fail clear | Message suggests CSV/Excel |

---

## 13. File / module map (implementation guide)

```text
apps/api/src/
  workspace/
    workspace.module.ts
    workspace.service.ts       # ensure, paths, TTL, quotas
    workspace.types.ts
    artifact.service.ts
  analyze/
    analyze.module.ts
    inspect.service.ts
    materialize.service.ts     # xlsx/csv → artifact
    query-table.service.ts     # AST → engine
    analyze.presets.ts         # tenure_top, value_counts
    analyze.limits.ts          # env knobs
  agent/
    agent.tools.ts             # register tools + prompt
    tool-summary.ts
    extract-sources.ts
  documents/ or ragflow/
    # file download helper for originals
```

Config: `apps/api/src/analyze/analyze-config.ts` mirroring `rag/rag-config.ts`.

---

## 14. API surface (Phase 2 download)

```http
GET /api/conversations/:conversationId/artifacts
GET /api/conversations/:conversationId/artifacts/:artifactId
GET /api/conversations/:conversationId/artifacts/:artifactId/download
```

All: session auth + `conversation.userId === currentUser`.  
No Phase 1 requirement if agent tools suffice.

---

## 15. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Model still only calls retrieve | Strong prompt + tool descriptions; optional Nest `suggestedPath`; eval gate |
| Bad column names / dates | inspect samples; preset requires explicit dateColumn; ask user to confirm |
| Huge Excel OOM | row caps; streaming CSV; reject with message |
| PDF tables | Explicit Phase 4; P1 errors tell user to upload Excel |
| Workspace disk growth | TTL job; per-conv byte cap; delete on conversation delete |
| Scope creep to “general agent” | Non-goals; no shell; review new tools against KB-bound rule |

---

## 16. Decisions locked (for implementers)

| Decision | Choice |
|----------|--------|
| Runtime | Single pi-agent-core agent; add tools (no multi-agent mesh in P1) |
| Workspace scope | Per conversation |
| Query language | Whitelist AST + presets; no raw SQL from model in P1 |
| Primary formats P1 | Excel + CSV |
| Ranking answers | Deterministic query_table; LLM only narrates |
| RAGFlow | Unchanged as knowledge engine |
| UI P1 | Optional; tool_end summaries minimum |

---

## 17. Open questions

1. Prefer **DuckDB**, **better-sqlite3**, or **in-process dataframe** for `query_table`? (Recommend DuckDB if native deps OK; else sqlite.)  
2. Store originals in workspace `inputs/` vs re-download from RAGFlow each materialize? (Recommend cache by contentHash in `inputs/`.)  
3. Should analyze tools work when UI selects **multiple KBs** but one document? (Yes — scope like summarize.)  
4. Admin visibility into workspace disk usage? (Defer to admin monitor track.)

---

## 18. Summary

pi-rag stays a **knowledge portal**.  
We add a **session workspace** and **analyze tools** so the agent can act as a **knowledge problem solver**: retrieve when text similarity is enough; **materialize + query** when the question needs the whole table.

That is the intentional gap-fill for questions like *总结最悠久的员工* without pretending one giant chunk or pure search can compute global extrema.
