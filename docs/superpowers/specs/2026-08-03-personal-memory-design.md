# Personal Memory (L1 Profile + L2 MemoryItem)

**Date:** 2026-08-03  
**Status:** Approved for planning  
**Product:** CSB Knowledge Base Portal — personal assistant memory layer  
**Stack:** NestJS + Prisma/Postgres + pi-agent-core (existing) + React Settings UI  

## 1. Problem & Goals

The portal already has:

| Layer | What it does | Gap |
|-------|----------------|-----|
| Conversation + messages (Postgres) | Per-chat history | Not shared across conversations |
| Agent compaction | Compress **in-session** context | Not durable cross-chat identity |
| RAGFlow knowledge bases | Document facts with citations | Not “about the user” |

Users want a **personal assistant** feel: the agent should remember who they are, how they like answers, and a small set of durable facts **across conversations**, without re-explaining every new chat.

### Goals (MVP)

1. **Cross-conversation identity & preferences** — language, style, display name, short bio.
2. **Editable durable facts** — user-visible MemoryItems that can be pinned, edited, deleted.
3. **Bounded prompt injection** — many items may be stored; only a budgeted subset enters each turn’s context.
4. **Same isolation model as KBs** — every row owned by `userId`; cross-user leakage is a hard fail.
5. **Fits existing agent** — inject a memory block into the existing pi-agent system/prefix path; do not migrate to RAGFlow Agent.

### Non-goals (this iteration)

- Semantic long-term recall over all past chats (L3: RAGFlow Memory API, private memory KB, or pgvector).
- Automatic LLM extraction of memories from every turn.
- Full life-assistant features (calendar, proactive todos, push).
- Using RAGFlow Memory as source of truth for chat history.
- Team / shared memories.
- Memory version history / audit log (beyond normal `updatedAt`).

### Product north star (phased)

| Phase | Scope |
|-------|--------|
| **MVP (this spec)** | L1 Profile + L2 MemoryItem in Postgres; passive prompt injection; Settings CRUD |
| **P1** | Agent tools `memory_save` / `memory_forget` (optional user phrases in chat) |
| **P2** | L3 semantic retrieval when stored items exceed what top-N injection can surface |

---

## 2. Product Decisions (Locked)

| Decision | Choice |
|----------|--------|
| MVP scope | L1 + L2 only; no L3 retrieval |
| Storage | Postgres via Prisma (source of truth) |
| RAGFlow Memory API | **Not used in MVP**; may be evaluated for L3 later |
| Write path | Manual in Settings (primary); tools deferred to P1 |
| Auto-extract from chat | No (schema may reserve `source=extracted`) |
| Agent integration | Passive injection every turn; not mid-tool-loop rewrite |
| Documents vs memory | Files / transcripts stay in **knowledge bases**; memory is about the **user** |
| Isolation | NestJS ownership; 404 on unauthorized access |

### User mental model

> - Long-term preferences and facts → **My memory** (Profile + MemoryItems).  
> - Document content → **Knowledge bases**.  
> - One-off instructions for this chat only → say them in the current conversation.  
> - First version only remembers what you save; it does not learn from all history automatically.

---

## 3. Memory Taxonomy

### 3.1 L1 — User Profile (always injected)

Stable settings about **who the user is** and **how the assistant should work**.

| Field | Purpose | Example |
|-------|---------|---------|
| `displayName` | How to address the user | 「阿明」 |
| `language` | Default reply language | `zh-Hant`, `en`, … |
| `responseStyle` | Length / tone / structure | short / detailed / bullet-first |
| `bio` | Free-text background | role, team, main work context |
| `prefs` (JSON) | Extensible key-value | no emoji, citation style, etc. |

Profile should stay **short**. If users paste essays, product should discourage or soft-cap length.

### 3.2 L2 — MemoryItem (budgeted injection)

One standalone, editable fact per row.

| Category | For | Good example | Bad example |
|----------|-----|--------------|-------------|
| `preference` | Habits, format rules | 「比較表一律用 markdown table」 | 「這次回短一點」(one-shot) |
| `fact` | Durable facts about user/world | 「直屬是王經理」 | Full meeting transcript |
| `project` | Decisions / project context | 「Q3 先做記憶 MVP，L3 延後」 | Daily diary spam |
| `other` | Anything else long-lived | 「週報格式：進度/風險/下周」 | Secrets the user will not manage in UI |

**Ideal content shape:** one self-contained sentence the model can use without prior turns.

### 3.3 What users can make the assistant remember

| Supported in MVP | Not supported by L1/L2 alone |
|------------------|------------------------------|
| Name, language, answer style | “Find everything I ever said about todos” |
| Work background, standing constraints | Open-ended recall of old chats not saved as items |
| Explicit decisions written as MemoryItems | Full document Q&A (use KBs) |
| Pin important rules so they almost always apply | Automatic learning from all conversations |

### 3.4 Division of responsibility

```text
┌──────────────────────┬────────────────────────────────────┐
│ Layer                │ Responsibility                     │
├──────────────────────┼────────────────────────────────────┤
│ Profile + MemoryItem │ Cross-chat identity & user facts   │
│ Conversation history │ Current thread + compaction        │
│ Knowledge bases      │ Documents, evidence, citations     │
│ L3 (future)          │ Retrieve among many MemoryItems    │
└──────────────────────┴────────────────────────────────────┘
```

---

## 4. Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  apps/web                                                   │
│  Settings → Profile form + MemoryItem list (CRUD, pin)      │
└──────────────────────────────┬──────────────────────────────┘
                               │ session cookie + CSRF
┌──────────────────────────────▼──────────────────────────────┐
│  apps/api                                                   │
│  MemoryModule                                               │
│    GET/PUT  /me/profile                                     │
│    CRUD     /me/memories                                    │
│    buildMemoryPromptBlock(userId)                           │
│                                                             │
│  AgentService (existing)                                    │
│    system/prefix = DOMAIN_SYSTEM_PROMPT                     │
│                  + memory block                             │
│                  + selected KB prefix (existing)            │
│                  + user question                            │
│                                                             │
│  Postgres: user_profiles, memory_items                      │
└─────────────────────────────────────────────────────────────┘
```

Principles:

1. Browser talks only to NestJS.
2. Memory services always filter by `userId` from auth.
3. Agent tools (P1) must close over the same `userId` and call MemoryService — never raw SQL with client-supplied owner ids.
4. RAGFlow remains document engine only for this phase.

---

## 5. Data Model (Prisma / Postgres)

### 5.1 `user_profiles`

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | UUID PK, FK → `users.id` ON DELETE CASCADE | 1:1 |
| `display_name` | TEXT NULL | |
| `language` | TEXT NULL | e.g. `zh-Hant`, `en`; null = fall back to system prompt defaults |
| `response_style` | TEXT NULL | short free text or small enum string |
| `bio` | TEXT NOT NULL DEFAULT `''` | soft max length enforced in API |
| `prefs` | JSONB NOT NULL DEFAULT `{}` | extensible |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

Lazy-create on first `GET /me/profile` or first injection if missing (empty profile).

### 5.2 `memory_items`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → `users.id` ON DELETE CASCADE | |
| `content` | TEXT | single fact; max length enforced |
| `category` | ENUM `preference` \| `fact` \| `project` \| `other` | default `other` |
| `pinned` | BOOLEAN DEFAULT false | always inject if active |
| `importance` | INT DEFAULT 3 | 1–5; higher preferred when selecting non-pinned |
| `source` | ENUM `manual` \| `extracted` | MVP writes only `manual` |
| `status` | ENUM `active` \| `archived` | archived never injected |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

Indexes:

- `(user_id, status, pinned, importance DESC, updated_at DESC)` for injection query  
- `(user_id, updated_at DESC)` for list UI  

### 5.3 Soft limits (API validation)

| Limit | Default | Rationale |
|-------|---------|-----------|
| `bio` max chars | 2000 | keep profile short |
| `display_name` max | 80 | |
| `response_style` max | 200 | |
| `memory_items.content` max | 500 | one sentence / short paragraph |
| Max active items per user | 500 (soft product cap) | list UX; storage is cheap |
| Max pinned active items | 15 | match inject budget so pins are not silently dropped |
| Prefs JSON serialized size | 4 KiB | |

Exact numbers may be env-tunable; defaults above are locked for MVP unless implementation discovers a better fit.

---

## 6. Prompt Injection

### 6.1 When

Before each agent turn that builds the user/system-facing prompt (same place selected-KB prefix is applied — typically in chat/agent path before `agent.prompt()`).

### 6.2 Selection algorithm

```text
1. Load profile for userId (or empty defaults).
2. Load candidates:
     status = active
     ORDER BY pinned DESC, importance DESC, updated_at DESC
3. Build block:
     a. Always include profile section (truncated to profile budget).
     b. Include ALL pinned items (already capped by max pin count).
     c. Add non-pinned items in order until memory-item token budget exhausted.
4. If total memory block > MEMORY_PROMPT_MAX_TOKENS, truncate from the
   lowest-priority tail (never drop profile header if possible; drop items first).
```

Token estimate: same conservative style as agent compaction — `ceil(chars / 4)` — for consistency.

### 6.3 Default budgets (env)

| Env | Default | Meaning |
|-----|---------|---------|
| `MEMORY_INJECTION_ENABLED` | `true` | kill switch for prompt injection |
| `MEMORY_PROMPT_MAX_TOKENS` | `2000` | hard cap for entire memory block (profile + items) |
| `MEMORY_PROMPT_MAX_ITEMS` | `15` | max MemoryItems injected per turn |
| `MEMORY_MAX_PINNED` | `15` | max active rows with `pinned=true` (API rejects more) |

**Locked selection rule:**

1. Consider only `status = active`.
2. Sort by `pinned DESC`, then `importance DESC`, then `updated_at DESC`.
3. Take the first `MEMORY_PROMPT_MAX_ITEMS` items.
4. Format profile + those items; if estimated tokens exceed `MEMORY_PROMPT_MAX_TOKENS`, drop items from the end of the sorted list until under budget (keep as much of the profile section as possible).
5. Separately, create/update that would result in more than `MEMORY_MAX_PINNED` pinned active items returns **400**.

Defaults keep `MEMORY_MAX_PINNED == MEMORY_PROMPT_MAX_ITEMS` so every pin can fit in the item budget under normal content lengths. Token cap still applies when individual items are long.

### 6.4 Block format

Use a clear, model-facing English/Chinese hybrid label consistent with existing prefixes:

```text
[User profile & memory — durable facts about this user; honor unless the user overrides in this chat]
Profile:
- Name: …
- Language: …
- Style: …
- Bio: …
Preferences: …

Memories:
- [preference][pinned] …
- [project] …
```

Rules for the model (append to block or fold into `DOMAIN_SYSTEM_PROMPT` once):

- Treat these as durable user context.
- If the current user message conflicts, **prefer the current message**.
- Do not invent memories not listed.
- Do not claim access to other users’ data.

### 6.5 Empty state

If no profile fields and no active items: inject nothing (or a single omitted section) — no empty noisy headers.

### 6.6 Interaction with compaction & RAG

| Mechanism | Scope |
|-----------|--------|
| Memory block | Cross-chat, fixed prefix budget |
| Agent compaction | In-session message history |
| RAG retrieve tools | Document evidence |

Memory prefix should stay small (~2k tokens) so RAG and multi-turn history retain room.

---

## 7. API Surface

All routes require authenticated user; operate only on `currentUser.id`.

### Profile

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/me/profile` | Return profile; create empty row if missing |
| `PUT` | `/me/profile` | Upsert fields; validate lengths |

### Memories

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/me/memories` | List; query: `status`, `category`; default active; order updated_at desc |
| `POST` | `/me/memories` | Create (`source=manual`) |
| `PATCH` | `/me/memories/:id` | Update content/category/pinned/importance/status |
| `DELETE` | `/me/memories/:id` | Hard delete (or archive-only — **locked: hard delete**) |

Errors:

- Not owned → 404  
- Pin would exceed max → 400  
- Content too long → 400  
- Active count soft cap exceeded → 400 with clear message  

Response DTOs use ISO timestamps; never expose other users’ ids.

---

## 8. Frontend (MVP)

**Settings** (or dedicated “My memory” section):

1. **Profile form** — display name, language, style, bio; save.  
2. **Memory list** — content, category badge, pin toggle, importance, archive/delete.  
3. **Add memory** — short form; content required.  
4. Optional helper copy: “Saved memories may not all appear every turn; pinned and important ones are preferred. Cap ≈ 15 per turn.”

Out of scope for MVP UI: semantic search over memories, bulk import, chat-inline “remember” button (P1).

---

## 9. Agent Tools (P1 — not MVP)

| Tool | Purpose |
|------|---------|
| `memory_save` | Create MemoryItem from user request (“記住：…”) |
| `memory_forget` | Archive/delete by id or fuzzy content match (prefer id from list) |

Tools bound with `userId` closure, same as retrieval tools.  
MVP ships **without** these to avoid uncontrolled writes until Settings UX is solid.

---

## 10. L3 / Future Options (not implemented)

When users routinely store more items than top-N can surface:

| Option | Idea | Notes |
|--------|------|-------|
| **A. RAGFlow Memory API** | External memory engine with search/forget | Version ≥ 0.23/0.24; map `userId → memory_id`; mock gap; dual systems |
| **B. Private memory KB** | Dedicated dataset + existing retrieve tools | Fits current RagflowService patterns |
| **C. Self-built vectors** | e.g. pgvector on `memory_items` | Full control; more build |

MVP intentionally chooses **none of the above**. L1/L2 remain valid when L3 is added: always inject profile + pins; retrieve additional items by query.

**Do not** use RAGFlow Memory as chat history store; Postgres conversations stay source of truth.

---

## 11. Security & Privacy

1. Ownership checks on every read/write.  
2. Memory block only for the authenticated user of that request.  
3. No memory content in admin cross-user views unless a future admin feature is explicitly designed.  
4. On user delete, cascade profiles and items.  
5. Logs: do not log full memory content at info level in production.

---

## 12. Testing

| Area | Cases |
|------|--------|
| Isolation | User A cannot read/update B’s profile or items |
| Selection | Pinned beat non-pinned; importance/recency order; max items cap |
| Token budget | Long content truncated / selection stops under max tokens |
| Pin cap | 16th pin rejected when max is 15 |
| Injection | Empty profile+items → no block; with data → stable format snapshot |
| API validation | Overlong content, invalid category |
| Agent path | Chat turn includes memory block for user with profile (integration or unit on builder) |

---

## 13. Implementation Outline

1. Prisma models + migration.  
2. `MemoryModule` / `MemoryService` (CRUD + `buildMemoryPromptBlock`).  
3. Wire injection into agent/chat prompt assembly.  
4. Controllers + DTOs under `/me/...`.  
5. Web Settings UI.  
6. Unit tests for selection + validation; light API tests if pattern exists.  
7. `.env.example` entries for memory env vars.  
8. P1 tools (later).  

### Suggested files

```text
apps/api/prisma/schema.prisma          # UserProfile, MemoryItem
apps/api/src/memory/                   # module, service, controller, dto
apps/api/src/memory/memory-prompt.ts   # pure selection + format (unit-tested)
apps/api/src/agent/agent.service.ts    # call buildMemoryPromptBlock
apps/web/src/...                       # Settings memory section
apps/api/test/memory-prompt.spec.ts
```

---

## 14. Success Criteria

1. New conversation without re-stating language/style still honors Profile.  
2. User adds a MemoryItem in Settings; next chat turn’s prompt includes it (if within top-N).  
3. User deletes/archives an item; it no longer appears in the block.  
4. User B never receives User A’s memory in any prompt or API.  
5. With 50 active items, injection still respects max items and token budget.

---

## 15. Open Points (resolved in this doc)

| Topic | Resolution |
|-------|------------|
| RAGFlow Memory for MVP? | No |
| Auto-extract? | No (reserve `source`) |
| Tools in MVP? | No (P1) |
| Hard delete vs archive | API supports archive via status; DELETE is hard delete |
| Too many items vs context | Store many; inject budgeted top-N + token cap |
| Defaults max pin / max inject | Both 15 |

---

## 16. References

- Existing agent prompt: `apps/api/src/agent/agent.tools.ts` (`DOMAIN_SYSTEM_PROMPT`, KB prefix)  
- Compaction (in-session only): `docs/superpowers/specs/2026-08-03-agent-compaction-design.md`  
- Portal design: `docs/superpowers/specs/2026-07-23-pi-rag-design.md`  
- RAGFlow Memory API (future L3 option only): https://ragflow.io/docs/http_api_reference#memory-management  
