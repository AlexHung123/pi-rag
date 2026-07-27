# Persistent Pi Agent Pool Design

**Date:** 2026-07-24  
**Status:** Approved  
**Parent:** [2026-07-23-pi-rag-design.md](./2026-07-23-pi-rag-design.md)  
**Scope:** Replace hand-rolled chat agent with `@earendil-works/pi-agent-core`, one agent per conversation in a bounded in-memory pool, Q&A over existing knowledge bases only.

## 1. Problem & Goals

### Problem

Chat today uses a custom OpenAI `fetch` loop plus a keyword-based fallback. The product design calls for `pi-agent-core`, but that package is not wired. There is no long-lived agent state across turns in a conversation.

### Goals

1. Use **`@earendil-works/pi-agent-core`** (with **`@earendil-works/pi-ai`**) for chat answers.
2. **One agent instance per conversation**, held in a **bounded in-memory pool** while the API process is alive.
3. When a question needs knowledge, the agent uses tools to **list owned KBs** and **retrieve chunks**, then answers from that context.
4. Knowledge bases are created/managed **manually via UI/API** — no create/parse agent tools.
5. **P0 persistence:** durable truth remains Postgres conversation messages (user + assistant). Live agent state is not durable.

### Non-goals

- Create / parse / upload tools on the agent
- Persisting tool-call turns or full `agent.state.messages` (P1)
- Pi SQLite/JSONL session backends (P2)
- Multi-node sticky sessions / Redis agent affinity
- Changing REST knowledge/document APIs or UI KB workflow

## 2. Decisions (Locked)

| Decision | Choice |
|----------|--------|
| Agent runtime | `@earendil-works/pi-agent-core` `Agent` |
| LLM layer | `@earendil-works/pi-ai` OpenAI-compatible custom provider |
| Lifecycle | **Approach B:** persistent agent per conversation |
| Capacity model | **Bounded pool** of conversation-bound sessions (not anonymous workers) |
| Tools | `retrieve_chunks` only (KBs selected by user in UI) |
| Persistence | **P0:** Postgres user/assistant messages only |
| Rehydrate source | Last N user/assistant messages from DB on pool miss |
| SSE contract | Keep existing client events |

## 3. Architecture

```text
POST /api/conversations/:id/messages  (SSE)
              │
              ▼
        ChatService.streamMessage
              │
              ├─ save user message (Postgres)
              ▼
        AgentSessionPool.getOrCreate(userId, conversationId)
              │
              │  hit  → reuse Agent (same conversation)
              │  miss → create Agent + hydrate history from Postgres
              ▼
        agent.prompt(userMessage)
              │
              ├─ tool: retrieve_chunks → RAGFlow (user-selected + owned dataset IDs only)
              ▼
        map pi events → SSE frames
              │
              ▼
        save assistant message (Postgres) → done
```

### Components

| Component | Responsibility |
|-----------|----------------|
| `AgentSessionPool` | In-memory map of conversation sessions; getOrCreate, dispose, TTL/LRU eviction |
| `createPiAgent` / model factory | Build pi-ai provider + `Agent` with system prompt and tools |
| `createUserTools` | Bound tools: retrieve only (user-selected KBs, ownership enforced) |
| `AgentService` | Orchestrate pool + prompt + event streaming for chat |
| `ChatService` | Ownership, message persistence, dispose on conversation delete |

## 4. Agent Session Pool

### Session shape

```ts
type AgentSession = {
  conversationId: string;
  userId: string;
  agent: Agent;
  lastUsedAt: number;
  busy: boolean;
};
```

### Rules

| Event | Behavior |
|-------|----------|
| First message (or pool miss) | Create `Agent`, hydrate last `AGENT_HISTORY_LIMIT` user/assistant turns from Postgres, then `prompt(content)` |
| Later message (pool hit) | Reuse same `Agent`, `prompt(content)` (in-memory history continues) |
| Conversation deleted | `pool.dispose(conversationId)` immediately |
| Idle longer than TTL | Evict session; next message rebuilds from DB |
| Pool at max capacity | Evict least-recently-used idle session; if none idle, await or fail gracefully |
| Concurrent message same conversation | Serialize: one `prompt` at a time (`busy` flag; await idle with timeout) |
| userId mismatch on existing session | Dispose session and return ownership failure (404) |
| API process restart | Pool empty; cold start rebuilds from Postgres |

### Defaults (env-overridable)

| Env | Default | Purpose |
|-----|---------|---------|
| `AGENT_POOL_MAX` | `100` | Max concurrent live agents |
| `AGENT_SESSION_TTL_MS` | `1800000` (30 min) | Idle eviction |
| `AGENT_HISTORY_LIMIT` | `20` | Max prior user/assistant pairs (or messages) when hydrating |
| `AGENT_PROMPT_WAIT_MS` | `120000` | Max wait if session busy |

### Multi-instance note

MVP assumes a **single API process**. Pool is process-local. Horizontal scale requires sticky sessions or external state (out of scope).

## 5. Persistence (P0)

| Layer | Contents | Durable? |
|-------|----------|----------|
| Postgres `conversations` + `messages` | User and assistant text (existing) | **Yes** |
| Pool `Agent` | Full pi messages including tool calls/results, stream state | **No** (memory only) |

### Cold start / rehydrate

1. Load owned conversation + recent messages (`role` in `user` \| `assistant`).
2. Map to pi `AgentMessage[]` (user/assistant text only).
3. Construct new `Agent` with `initialState.messages` = that history.
4. Run `prompt(newUserMessage)`.

Tool turns from prior live sessions are **not** restored under P0. Continuity of Q&A text is enough for MVP.

## 6. Model Wiring (pi-ai)

Reuse existing OpenAI-compatible env:

```bash
OPENAI_BASE_URL=http://host:port/v1
OPENAI_MODEL=...
OPENAI_API_KEY=not-needed   # optional for local servers
```

Implementation sketch:

- `createModels()` + `createProvider` with `openAICompletionsApi()`
- Provider id e.g. `local-openai`
- Model metadata: `api: 'openai-completions'`, `baseUrl` from env, conservative `compat` for local servers (`supportsDeveloperRole: false` if needed)
- `streamFn: models.streamSimple.bind(models)`

If neither `OPENAI_BASE_URL` nor a usable key/config is present, stream an SSE `error` (or a single clear assistant error message). **Do not** fall back to create-KB keyword heuristics.

## 7. Tools

### `retrieve_chunks`

- **Input:** `question` (required), `knowledgeBaseIds` / `knowledgeBaseId` (user-selected; required for search), optional `topK`  
- **Behavior:**  
  - Require user-selected KB ids from the UI (never auto-list or invent KBs)  
  - Resolve owned KBs for `userId` and filter to selected ids only  
  - Map to RAGFlow dataset ids  
  - Call `ragflow.retrieve`  
  - Return hits as JSON (content, scores, doc names, KB ids/names)  
- **Security:** never accept raw RAGFlow dataset ids from the model; only app UUIDs validated via ownership services

### Removed from agent surface

- `list_my_knowledge_bases` (KB selection is UI-only)
- `create_knowledge_base`
- `list_documents`, `parse_documents`, `preview_document` (UI/API remains)

### System prompt (intent)

- Domain Q&A assistant for the current user’s knowledge bases.
- Knowledge bases are selected only by the user in the UI; agent must not list or pick KBs.
- For factual/domain questions with selected KBs: call `retrieve_chunks` with those ids.
- Do not invent document content; if retrieval is empty/irrelevant, say you don’t know from the selected knowledge bases.
- KB create/upload/parse/select is done in the UI — do not claim to create or list KBs via tools.

## 8. Event → SSE Mapping

Preserve the existing web client contract:

| pi-agent-core event | SSE `event` | `data` |
|---------------------|-------------|--------|
| (user saved) | `user_message` | message row (existing ChatService behavior) |
| `tool_execution_start` | `tool_start` | `{ name }` |
| `tool_execution_end` | `tool_end` | `{ name, ok }` |
| assistant `message_update` with text delta | `text_delta` | `{ delta }` |
| run complete | `assistant_message` | persisted assistant row |
| failure | `error` | `{ message }` |
| after assistant saved | `done` | `{}` |

Collect full assistant text from stream/final message for DB persistence.

## 9. Error Handling

| Case | Behavior |
|------|----------|
| Conversation not owned | 404 (existing) |
| LLM/provider failure | SSE `error`; still persist best-effort assistant text or error summary |
| Tool failure | Tool throws; pi surfaces tool error to model; map `tool_end` with `ok: false` when detectable |
| Busy timeout | SSE `error` “agent busy” |
| Pool pressure | Evict idle; if cannot create session, SSE `error` |

## 10. Files to Change

| Path | Change |
|------|--------|
| `apps/api/package.json` | Add `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` |
| `apps/api/src/agent/agent-session.pool.ts` | **New** pool/registry |
| `apps/api/src/agent/pi-model.ts` | **New** provider/model factory from env |
| `apps/api/src/agent/agent.tools.ts` | Slim to list + retrieve; TypeBox schemas if required by pi |
| `apps/api/src/agent/agent.service.ts` | Rewrite: pool + `agent.prompt` + event mapping |
| `apps/api/src/chat/chat.service.ts` | Dispose pool entry on conversation delete; pass history for hydrate |
| `.env.example` | Pool TTL/max + existing OpenAI vars |
| `README.md` | Note pi-agent-core + pool behavior |

No Prisma schema change for P0.

## 11. Testing Strategy

- **Unit:** pool getOrCreate reuses same session; dispose removes; max capacity evicts LRU; userId mismatch disposes
- **Unit:** tools reject non-owned `knowledgeBaseId` (via service 404)
- **Manual/integration:** send two messages in one conversation → second reuses agent (log/metrics optional); restart API → third message still answers with DB history
- **Manual:** domain question with parsed docs → `retrieve_chunks` then grounded answer; empty KB → honest “no knowledge” answer

## 12. Acceptance Criteria

1. Typing a normal question runs a **pi-agent-core** `Agent` (not the old keyword create-KB path).
2. Same conversation reuses the same pool session until TTL/eviction/delete/restart.
3. Agent can list owned KBs and retrieve chunks; answers use retrieved content when relevant.
4. Agent cannot create knowledge bases via tools.
5. After API restart, chat history remains and a new agent is rebuilt from Postgres.
6. Existing SSE chat UI continues to work without protocol changes.

## 13. Follow-ups (explicitly deferred)

| Topic | When |
|-------|------|
| P1: persist tool/agent messages JSON | After MVP chat quality issues on cold start |
| P2: pi session SQLite backend | If multi-turn tool continuity must survive restarts |
| Multi-instance pool affinity | When running >1 API replica |
| Citations structured in UI | After grounded answers are stable |
