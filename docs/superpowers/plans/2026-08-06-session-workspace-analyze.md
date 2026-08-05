# Session Workspace + Analyze Tools — Implementation Plan

**Date:** 2026-08-06  
**Status:** Ready to implement  
**Spec:** [`../specs/2026-08-06-session-workspace-analyze-design.md`](../specs/2026-08-06-session-workspace-analyze-design.md)  
**Product:** CSB Knowledge Base Portal (`pi-rag`)

---

## Goal

Ship a **Knowledge Problem-Solving** path on top of the existing agent:

1. Session workspace (scratch artifacts per conversation)
2. Analyze tools: inspect → materialize → query
3. Prompt routing so aggregate questions stop using retrieve-only

---

## Phase 1 — Table solver MVP

### Task 1.1: Config + feature flag

- [ ] Add `apps/api/src/analyze/analyze-config.ts` (TTL, byte caps, row caps, `ANALYZE_ENABLED`)
- [ ] Document env vars in `apps/api` README or root README (short section)
- [ ] Defaults safe for local dev

### Task 1.2: Prisma models

- [ ] `SessionWorkspace` + `WorkspaceArtifact` (+ enum `WorkspaceArtifactKind`)
- [ ] Relations on `User` / `Conversation` with cascade delete
- [ ] Migration under `apps/api/prisma/migrations/`
- [ ] `npx prisma migrate` / generate works

### Task 1.3: Workspace service

- [ ] `apps/api/src/workspace/workspace.service.ts`
  - `ensureForConversation(userId, conversationId)`
  - resolve paths under `WORKSPACE_ROOT` (reject traversal)
  - quota checks
  - `deleteWorkspace` / expire by `expiresAt`
- [ ] Lazy expire on access + optional simple interval cleanup
- [ ] Unit tests: path safety, ownership (conversation must belong to user)

### Task 1.4: Materialize (xlsx/csv)

- [ ] Download original via existing RAGFlow/documents path (reuse portal storage if present)
- [ ] `materialize.service.ts`: csv/xlsx → `derived/{id}.csv` (+ meta schema, rowCount, contentHash)
- [ ] Cache hit on same contentHash
- [ ] Enforce `ANALYZE_MAX_ROWS_MATERIALIZE`
- [ ] Fixture tests under `apps/api/test/` or `testdata/analyze/`

### Task 1.5: Query engine + presets

- [ ] `query-table.service.ts`: whitelist AST (select/where/groupBy/orderBy/limit)
- [ ] Preset `tenure_top` (id columns + date column → min date, sort desc, limit)
- [ ] Preset `value_counts` / `describe` (optional if time)
- [ ] Inline row/char clip; overflow → `query_result` artifact
- [ ] Gold-file test: tenure ranking on fixture CSV

### Task 1.6: Agent tools + prompt

- [ ] Register in `createUserTools`:
  - `inspect_document`
  - `materialize_table`
  - `query_table`
  - `list_artifacts`
- [ ] Gate on `ANALYZE_ENABLED` and selected KB scope (`resolveRetrievalScope` / document scope)
- [ ] Extend `DOMAIN_SYSTEM_PROMPT` routing (analyze vs retrieve vs summarize)
- [ ] `tool-summary.ts` cases
- [ ] `extract-sources` / citation for analysis + source document
- [ ] Wire deps in `AgentService.createAgent`

### Task 1.7: Build + smoke

- [ ] `npm run build -w @pi-rag/api`
- [ ] Unit tests green
- [ ] Manual smoke: upload small Excel KB → chat「最悠久的员工」→ expect materialize + query in tool trace

### Task 1.8: Commit

- [ ] Branch e.g. `feat/session-workspace-analyze-p1`
- [ ] Commit with message referencing the spec

---

## Phase 2 — UX + more sources

- [ ] `read_artifact` tool
- [ ] REST: list/get/download artifacts for conversation
- [ ] Light web UI: artifacts list + download
- [ ] Markdown table extraction from ordered chunks (best-effort)
- [ ] Nest turn prefix `Suggested path: analyze|retrieve|summarize` heuristic

---

## Phase 3 — Sandbox code

- [ ] Design worker isolation (no network, mounts, limits) — short addendum to spec if needed
- [ ] `run_analysis_code` tool
- [ ] Run-limit integration (separate cap)
- [ ] Tests: reject network / path escape

---

## Phase 4 — PDF / MinerU tables (optional)

- [ ] Clean table symbols → CSV pipeline
- [ ] On-demand or ingest-time materialize path
- [ ] Eval cases for multi-page tables

---

## Eval checklist (Phase 1 gate)

| # | Case | Pass? |
|---|------|-------|
| 1 | tenure top on fixture CSV | [ ] |
| 2 | count/groupBy matches gold | [ ] |
| 3 | prose lookup still retrieve | [ ] |
| 4 | whole-doc summary still summarize_document | [ ] |
| 5 | no KB → no analyze leak | [ ] |
| 6 | foreign doc id → denied | [ ] |

---

## Out of scope reminders

- No arbitrary shell
- No raw SQL from the model in Phase 1
- No second chat product
- Do not replace RAGFlow retrieval for normal QA
