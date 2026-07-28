# CSB Knowledge Base Portal

Multi-user knowledge base portal: **React + NestJS + Postgres + RAGFlow + pi-agent-core**.

Each user has isolated knowledge bases. Pipeline:

1. Create knowledge base (UI)  
2. Upload document  
3. Parse / cut chunks  
4. Preview chunks  
5. Chat with a pooled **pi-agent-core** agent that retrieves from owned KBs  

Design:

- [`docs/superpowers/specs/2026-07-23-pi-rag-design.md`](docs/superpowers/specs/2026-07-23-pi-rag-design.md)
- [`docs/superpowers/specs/2026-07-24-pi-agent-pool-design.md`](docs/superpowers/specs/2026-07-24-pi-agent-pool-design.md)

## Prerequisites

- Node.js 20+
- Docker (for Postgres)
- Optional: a running [RAGFlow](https://ragflow.io) instance + API key  
  Without RAGFlow, set `RAGFLOW_MOCK=true` to use an in-memory mock engine.

## Quick start

```bash
# 1) Postgres
docker compose up -d

# 2) Env
cp .env.example apps/api/.env
# edit apps/api/.env if needed

# 3) Install
npm install

# 4) DB schema (prefer migrate; push is a local escape hatch)
npm run db:migrate:deploy
# Fresh empty DB also works with: npm run db:migrate
# Existing DBs that were only ever `db push`'d: after first pull of migrations, once:
#   npx prisma migrate resolve --applied 20260728120000_init -w @pi-rag/api
#   (from apps/api: npx prisma migrate resolve --applied 20260728120000_init)

# 5) Run API + Web (two terminals)
npm run dev:api
npm run dev:web
```

- Web: http://localhost:5173  
- API: http://localhost:3001/health  

Sign in (create the first admin via `ADMIN_USERNAME` / `ADMIN_PASSWORD` on empty DB, or use Admin → Users). Open **Knowledge**, create a KB, upload a `.txt`/`.md` file, **Parse**, **Preview**, then chat.

## Configuration

See [`.env.example`](.env.example).

| Variable | Meaning |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY` | Real RAGFlow instance |
| `RAGFLOW_MOCK` | `true` = in-memory mock (no RAGFlow). Production requires API key unless this is explicitly `true` |
| `LLM_DEBUG` | `true` = dump full LLM request payloads to `apps/api/data/llm-debug/` (default off) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Bootstrap first admin when the users table is empty |
| `OPENAI_API_KEY` | API key for OpenAI-compatible LLM (optional for local servers) |
| `OPENAI_BASE_URL` / `OPENAI_MODEL` | OpenAI-compatible endpoint and model (required for chat agent) |
| `AGENT_POOL_MAX` | Max live pi agents in memory (default 100) |
| `AGENT_SESSION_TTL_MS` | Idle agent eviction TTL (default 30m) |
| `AGENT_HISTORY_LIMIT` | Max prior messages when rehydrating agent (default 20) |

## Workspace layout

```text
apps/api   NestJS API (auth, KB, documents, chat, ragflow client, agent)
apps/web   React + Vite UI
docs/      Design specs
```

## Isolation model

- NestJS is the only public API; browser never talks to RAGFlow.
- Postgres stores `owner_user_id` on knowledge bases / documents / conversations.
- All list/get/mutate paths filter by the session user (404 on cross-user access).

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev:api` | NestJS watch mode |
| `npm run dev:web` | Vite dev server (proxies `/api`) |
| `npm run db:push` | Prisma db push (local escape hatch only) |
| `npm run db:migrate` | Prisma migrate dev (create/apply during development) |
| `npm run db:migrate:deploy` | Prisma migrate deploy (CI / shared / production) |
| `npm run test:api` | API unit tests (Vitest) |
| `npm run build` | Build api + web |
