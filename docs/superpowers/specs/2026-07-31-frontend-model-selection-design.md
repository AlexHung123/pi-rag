# Frontend model selection (v1)

**Date:** 2026-07-31  
**Status:** Approved for implementation planning  
**Approach:** Server allowlist + optional `modelId` per chat message + composer picker

## Goal

Let users pick which chat LLM model to use **per message** in the web UI, from a **server-configured allowlist**. Default remains `OPENAI_MODEL`. No model labels on transcript messages.

## Decisions

| Topic | Choice |
|--------|--------|
| Model list source | Server env allowlist (`OPENAI_MODELS`) |
| Selection scope | Per message |
| Default | Always `OPENAI_MODEL` (no localStorage / last-used preference) |
| Transcript UI | Picker only; do not show model on messages |
| Gateway | Single OpenAI-compatible endpoint; only model **id** changes |

## Config

Keep existing:

- `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` (default model id)

Add:

- `OPENAI_MODELS` — optional comma-separated allowlist, e.g.  
  `OPENAI_MODELS=qwen3.6-35b-a3b-mlx,gpt-4o-mini`

### Allowlist resolution

1. Parse `OPENAI_MODELS`: split on `,`, trim, drop empties, dedupe (preserve first-seen order).
2. If the list is empty → `[OPENAI_MODEL]` (after trim; fallback `gpt-4o-mini` only if already used elsewhere as today).
3. If the list is non-empty and `OPENAI_MODEL` is not present → **prepend** default so it is always selectable.

Document in `.env.example`.

## API

### `GET /api/models` (auth required)

Response:

```json
{
  "defaultModelId": "qwen3.6-35b-a3b-mlx",
  "models": [
    { "id": "qwen3.6-35b-a3b-mlx" },
    { "id": "other-model" }
  ]
}
```

- No display `name` in v1; UI shows `id`.
- Same session/auth as other chat APIs.

### `POST /api/conversations/:id/messages`

- Extend body with optional `modelId?: string` (non-empty if present; max length ~128).
- Resolve effective model:
  - omit / empty → `defaultModelId`
  - provided → must be in allowlist or **400** (`model not allowed`)
- Prefer validating **before** persisting the user message so a bad model does not create a row.

No new SSE events. Do **not** store `modelId` on message metadata in v1.

## Agent integration

pi-agent-core holds the active model on agent state, not on `prompt()`:

```ts
agent.state.model = /* model with resolved id */;
await agent.prompt(...);
```

On each message, after acquiring the pooled session and **before** `prompt()`:

1. Build a model object via the existing pi-model factory (same `baseUrl`, key, compat, token limits).
2. Set `id` / `name` to the resolved model id.
3. Assign `session.agent.state.model`.

Do not dispose/recreate the pool session solely for a model switch. History stays on the agent; only the next completion uses the new id.

Admin agent-session monitor may show the model currently on `agent.state.model` (last used on that live session).

## Frontend

### Client

- Fetch `GET /api/models` when the chat UI loads.
- `selectedModelId` initializes to `defaultModelId`.
- No localStorage.
- After each send **completes** (success, stream error, or abort), reset `selectedModelId` to `defaultModelId` so the next message defaults again.
- `chatApi.streamMessage` includes `modelId` in the JSON body (the value selected for that send).

### UI

- Single-select in the composer input stack (same visual language as the knowledge-base control).
- Disabled while sending.
- If `models.length <= 1`, **hide** the picker (single-model deploys unchanged).
- List fetch failure: do not block chat; omit `modelId` on send so the server uses default; optional muted handling via existing error patterns only if needed later.

### Errors

- Server “model not allowed” → existing chat error banner.

## Files (expected)

| Area | Paths |
|------|--------|
| Model helpers | `apps/api/src/agent/pi-model.ts` (or small sibling module) |
| List endpoint | New controller/module or chat-adjacent route under `GET /api/models` |
| DTO / stream | `chat.dto.ts`, `chat.controller.ts`, `chat.service.ts` |
| Agent run | `agent.service.ts` |
| Env docs | `.env.example` |
| Web API | `apps/web/src/services/api.ts` |
| Web UI | `apps/web/src/App.tsx`, `apps/web/src/styles/index.css` |
| Tests | allowlist parsing; reject unknown `modelId`; optional agent model-set unit test |

## Tests

1. Allowlist: empty env → `[default]`; default prepended when missing; dedupe; trim.
2. Post message: unknown `modelId` → 400; omit → accepts and uses default.
3. Optional: run path assigns `agent.state.model.id` before prompt (mocked pool).

## Out of scope (v1)

- Message metadata / labels showing which model answered
- Gateway `/v1/models` discovery
- Multiple providers or base URLs
- localStorage or per-conversation sticky model preference
- Display names / structured model registry beyond ids

## Success criteria

- Operator configures `OPENAI_MODELS` (and default `OPENAI_MODEL`); UI lists only those ids.
- User can pick a non-default model for one message; that completion uses that id on the shared gateway.
- Next composer state is back to default without refresh.
- Invalid `modelId` is rejected server-side.
- Single-model setups need no UI change (picker hidden).
