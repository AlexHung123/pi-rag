# RAG Quality P2 Design

**Date:** 2026-07-28  
**Status:** Design (not yet implemented)  
**Product:** CSB Knowledge Base Portal (`pi-rag`)  
**Depends on:** Product MVP + RAGFlow dataset create (not blocked on P1 code)  
**Related:** P0 retrieval ([`2026-07-28-rag-quality-p0.md`](./2026-07-28-rag-quality-p0.md)), P1 tools ([`2026-07-28-rag-quality-p1-design.md`](./2026-07-28-rag-quality-p1-design.md))  
**Next (eval/debug):** [`2026-07-28-rag-quality-p3-design.md`](./2026-07-28-rag-quality-p3-design.md)  
**Roadmap:** [`2026-07-28-rag-quality-roadmap.md`](./2026-07-28-rag-quality-roadmap.md)  
**Plan checklist:** [`../plans/2026-07-28-rag-quality.md`](../plans/2026-07-28-rag-quality.md)

---

## 1. Goal

P0/P1 improve **query-time** retrieval and orchestration.  
P2 improves **ingest-time** quality so the index itself is a better fit for the corpus:

1. **Chunk / parser presets** — users pick a business profile; Nest maps to RAGFlow `chunk_method` + `parser_config`
2. **Parse health signals** — after parse `done`, flag pathological chunking
3. **Operator docs** — when to use which preset; how this relates to `RAG_*` query knobs

**Core idea:** raise the **recall ceiling**. No amount of hybrid/rewrite fixes documents that were sliced badly.

**Non-goals for P2:**

- Replacing RAGFlow parsers / building an in-house chunker
- Full parent–child indexing if the deployed RAGFlow cannot express it cleanly
- Changing chat/agent tools (that is P1)
- Golden-set eval / retrieval debug UI (that is P3)
- Mandatory re-parse of existing KBs when presets ship (create-time only for MVP)

---

## 2. Current state

### Already in place

| Piece | Location |
|-------|----------|
| `chunkMethod`, `parserConfig` on KB | Prisma `KnowledgeBase` |
| Create dataset with method/config | `KnowledgeService.create` → `RagflowService.createDataset` |
| DTO allows raw overrides | `CreateKnowledgeBaseDto.chunkMethod?`, `parserConfig?` |
| Default | `naive` + `{}` |

### Gaps

| Gap | Impact |
|-----|--------|
| No product-level **presets** | Users stay on `naive` for every corpus type |
| No guided UI for method/config | Only advanced/raw fields (if exposed at all) |
| Parse lifecycle is `unstart/running/done/fail` only | “Done but useless chunks” is invisible |
| No operator guidance | Confuse query knobs (`RAG_*`) with ingest settings |

---

## 3. Design principles

1. **RAGFlow remains the engine** — presets are a **mapping layer**, not a second parser.
2. **Server is source of truth** — preset → `{ chunkMethod, parserConfig }` lives in Nest; UI only sends `preset` (or advanced override).
3. **Create-time first** — set method when the dataset is created; avoid half-updated RAGFlow datasets in MVP.
4. **Fail soft on health** — warnings never block download/preview; they guide re-upload / new KB with better preset.
5. **Independent of P1** — can ship in parallel; recommend P1a first only if eng bandwidth is limited and “search miss” > “bad chunks” in feedback.

---

## 4. Slice order

```text
P2a  Preset map + create KB accepts preset     ← first
P2b  Create-KB UI preset picker
P2c  Parse health after done + list badges
P2d  Operator docs (README / superpowers)
```

| Slice | Effort (rough) | Risk |
|-------|----------------|------|
| P2a | 0.5–1 day | Medium (must match real RAGFlow methods) |
| P2b | ~0.5 day | Low |
| P2c | 0.5–1 day | Low |
| P2d | short | Low |

**Minimum valuable P2** = **P2a + P2b** (presets users can actually choose).

---

## 5. P2a — Chunk presets (server)

### 5.1 Module

**New:** `apps/api/src/knowledge/chunk-presets.ts` (name flexible)

```ts
export type ChunkPresetId = 'general' | 'policy' | 'manual' | 'faq';

export type ChunkPreset = {
  id: ChunkPresetId;
  label: string;           // i18n key or en/zh label
  description: string;     // short help for UI
  chunkMethod: string;     // RAGFlow chunk_method
  parserConfig: Record<string, unknown>;
};

export const CHUNK_PRESETS: Record<ChunkPresetId, ChunkPreset> = { ... };

export function resolveChunkPreset(
  input: { preset?: string; chunkMethod?: string; parserConfig?: Record<string, unknown> },
): { chunkMethod: string; parserConfig: Record<string, unknown>; preset?: ChunkPresetId } {
  // 1) If raw chunkMethod provided (advanced), use it (+ optional parserConfig)
  // 2) Else if preset known, map
  // 3) Else default general
}
```

### 5.2 Suggested preset table

Exact `chunk_method` / `parser_config` keys **must be validated against the deployed RAGFlow version**. Below is the **intent**; implementers adjust names after a quick console/API check.

| Preset id | User-facing | Intent | Mapping direction |
|-----------|-------------|--------|-------------------|
| `general` | 通用文档 | Mixed PDF/Word/txt | `naive` + balanced chunk token / overlap |
| `policy` | 制度 / 法规 | Numbered articles, formal docs | `laws` (or closest supported) |
| `manual` | 产品手册 / 结构化说明 | Headings, manuals | book / manual / markdown-friendly method if available; else `naive` with larger overlap |
| `faq` | FAQ / 短问答 | Atomic Q&A | smaller chunk size, overlap ≈ 0 |

Example shape (illustrative — tune numbers on real RAGFlow):

```ts
general: {
  chunkMethod: 'naive',
  parserConfig: {
    // keys depend on RAGFlow; examples only:
    // chunk_token_num: 512,
    // chunk_overlap: 64,
  },
},
faq: {
  chunkMethod: 'naive',
  parserConfig: {
    // chunk_token_num: 256,
    // chunk_overlap: 0,
  },
},
```

**Implementation step 0:** document the tested RAGFlow version and confirmed method names in this file’s “Appendix” or a comment in `chunk-presets.ts`.

### 5.3 Create KB API

Extend create body (backward compatible):

```ts
{
  name: string;
  description?: string;
  visibility?: 'private' | 'public';
  preset?: 'general' | 'policy' | 'manual' | 'faq';  // preferred
  chunkMethod?: string;   // advanced override
  parserConfig?: object;  // advanced override
}
```

Resolution order:

1. If `chunkMethod` set → advanced path (optional merge `parserConfig`)
2. Else if `preset` set → preset map
3. Else → `general`

Then:

```text
resolve → ragflow.createDataset({ chunkMethod, parserConfig })
       → prisma.knowledgeBase.create({ chunkMethod, parserConfig, ... })
```

**Optional schema:** add `preset String?` column for display/analytics. Not required for MVP if UI can reverse-map method+config or just show stored method.

### 5.4 List / get serialization

Expose for UI:

```ts
{
  chunkMethod: string;
  parserConfig: object;
  preset?: string | null;  // if stored or inferred
}
```

Endpoint (optional): `GET /api/knowledge-bases/chunk-presets` → list presets for the create dialog (avoids hardcoding labels only on web).

### 5.5 Explicitly out of scope for P2a

- Updating preset on an **existing** KB and bulk re-parse (see §9 Follow-ups)
- Per-document method override (KB-level only for MVP)

### 5.6 Acceptance (P2a)

- [ ] Preset map is single source of truth on server
- [ ] Create with `preset=faq` (etc.) persists method/config and creates RAGFlow dataset accordingly
- [ ] Advanced `chunkMethod` still works
- [ ] Invalid preset → 400 with clear message
- [ ] Build passes

---

## 6. P2b — Create-KB UI

### UX

On create knowledge base:

- Primary control: **preset cards or select** with label + one-line description
- Advanced (collapsed): raw `chunkMethod` / JSON config for admins/power users
- Default selection: `general`

Copy language: business terms (制度 / 手册 / FAQ / 通用), not “naive parser”.

### API client

`createKnowledgeBase({ name, preset, ... })` in `apps/web/src/services/api.ts`.

### Acceptance (P2b)

- [ ] User can create KB with each preset without typing method strings
- [ ] Created KB detail shows method (and preset if available)
- [ ] No regression on share/visibility create fields

---

## 7. P2c — Parse health

### When to compute

After document status transitions to / is refreshed as **`done`** (existing poll / `refreshStatus` path in documents service).

Optional: recompute when listing chunks if `chunkCount` changes.

### Signals (heuristics, no LLM)

Use fields already available: `sizeBytes`, `chunkCount`, optionally sample from `listChunks`.

| Signal | Example rule (tune constants) | Severity |
|--------|-------------------------------|----------|
| Too few chunks for size | e.g. `sizeBytes > 50_000 && chunkCount < 3` | warn/bad |
| Zero chunks but done | `chunkCount === 0` | bad |
| Suspicious average size | `sizeBytes / chunkCount` huge or tiny (if both known) | warn |
| Empty content ratio | sample first N chunks; empty/whitespace > 30% | warn |

Keep rules in one module: `apps/api/src/documents/parse-health.ts`.

```ts
type ParseHealth = {
  status: 'ok' | 'warn' | 'bad' | 'unknown';
  warnings: string[];  // short, user-facing or i18n keys
};
```

### Persistence

| Approach | Pros | Cons |
|----------|------|------|
| **A. Compute on read** (MVP) | No migration | Extra work each list; no history |
| **B. Columns on Document** | Fast list, stable | Migration |

**Recommend MVP = A**, upgrade to B if expensive.

### API / UI

- Document serialize includes `health?: ParseHealth`
- Document list: badge “分块异常” / tooltip with `warnings`
- Admin document monitor: same field if it reuses serialize

Health **must not** block preview/download.

### Acceptance (P2c)

- [ ] Done + 0 chunks → bad/warn visible
- [ ] Normal small txt → ok or unknown, not noisy false bad
- [ ] Unauthorized users still get 404 on foreign docs

---

## 8. P2d — Operator docs

Add a short section (README and/or this folder):

1. Preset → when to use  
2. Create-time only: changing corpus type may mean **new KB + re-upload**  
3. Ingest presets vs query env (`RAG_TOP_K`, etc.) are different layers  
4. Point to tested RAGFlow version + preset map file  

### Acceptance (P2d)

- [ ] Link from roadmap / plan to operator notes
- [ ] New contributors can choose a preset without reading RAGFlow source

---

## 9. Follow-ups (not P2 MVP)

| Item | Why later |
|------|-----------|
| Change preset on existing KB + reparse all docs | RAGFlow dataset mutation + job UX |
| Per-document parser override | Product complexity |
| Auto summary chunk enrichment | Optional quality boost; needs design |
| Parent–child / hierarchical chunk | Depends on engine capabilities |
| Wire health into P3 golden set | Natural once eval exists |

---

## 10. File map (proposed)

| Path | Slice | Action |
|------|-------|--------|
| `apps/api/src/knowledge/chunk-presets.ts` | P2a | **New** — map + resolve |
| `apps/api/src/knowledge/knowledge.dto.ts` | P2a | `preset?` |
| `apps/api/src/knowledge/knowledge.service.ts` | P2a | resolve on create; optional list presets |
| `apps/api/src/knowledge/knowledge.controller.ts` | P2a | optional GET presets |
| `apps/api/src/documents/parse-health.ts` | P2c | **New** — heuristics |
| `apps/api/src/documents/documents.service.ts` | P2c | attach health on serialize / refresh |
| `apps/web` create KB dialog | P2b | preset picker |
| `apps/web` document list | P2c | badge |
| `prisma/schema.prisma` | optional | `preset` on KB; health columns on Document |
| `.env.example` / README | P2d | only if env thresholds for health |
| `docs/superpowers/...` | P2d | operator notes |

---

## 11. PR sequence

| PR | Content |
|----|---------|
| **PR-P2a** | `chunk-presets` + create API |
| **PR-P2b** | Web create-KB preset UI |
| **PR-P2c** | Parse health + badges |
| **PR-P2d** | Docs only (can merge with a or c) |

Branch naming: `feat/rag-quality-p2` or stacked `p2a` / `p2b`.

---

## 12. Testing plan

### Automated

- Unit: `resolveChunkPreset` matrix (preset / override / default / invalid)
- Unit: parse-health rules with fixture sizes/counts
- Build: `npm run build -w @pi-rag/api` (+ web if UI)

### Manual

| Case | Expected |
|------|----------|
| Create with each preset | RAGFlow dataset created; local row matches method/config |
| Create with raw chunkMethod | Advanced path works |
| Upload + parse normal md | health ok (or unknown), chunks preview sensible |
| Force empty/fail path | fail status unchanged; done+0 chunks shows warn/bad |
| Shared KB viewer | can see health badge if can read; cannot change preset |

### RAGFlow version gate

Before locking preset map, run against the target instance:

```text
- list supported chunk methods (docs or create trial datasets)
- confirm parser_config keys not rejected
- record version in chunk-presets.ts header comment
```

---

## 13. Risks

| Risk | Mitigation |
|------|------------|
| Preset method name wrong for RAGFlow build | Validate on staging; keep `general`/`naive` safe default |
| Users expect mid-flight preset change | UI copy: preset applies at create; re-upload guidance |
| Health false positives on tiny files | Size floors; `unknown` when data insufficient |
| parser_config silently ignored by engine | Log create payload; spot-check chunk shapes per preset |
| Divergence admin create vs user create | Both call same `resolveChunkPreset` |

---

## 14. Relation to other phases

```text
Ingest (P2)                         Query (P0 / P1)
preset → parse → index              rewrite → hybrid/keyword → answer
        │                                  ▲
        └──────── recall ceiling ──────────┘
```

| Symptom | Likely phase |
|---------|----------------|
| Concept OK, error codes miss | P1 keyword |
| Whole policy is 2 huge chunks / thousands of crumbs | P2 preset |
| Multi-turn “上面那个” wrong | P0 rewrite / P1 |
| Need regression numbers | P3 |

---

## 15. Success criteria

1. New KBs are created with an intentional corpus profile, not only default `naive` by habit.
2. Pathological parses are visible without opening chunk preview every time.
3. Operators can explain preset vs `RAG_*` query settings.
4. No change required to agent tools for P2 to deliver value.
5. Architecture stays: Nest mapping + RAGFlow execution + existing ownership.

---

## 16. One-line decision

> **P2 is create-time business presets mapped to RAGFlow chunk/parser settings, plus lightweight parse-health warnings — improve the index, not the chat loop.**
