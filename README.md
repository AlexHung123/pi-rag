# pi-rag

Vertical-domain RAG expert: **React + NestJS + Postgres + RAGFlow + agent tools**.

Each user has isolated knowledge bases. Pipeline:

1. Create knowledge base  
2. Upload document  
3. Parse / cut chunks  
4. Preview chunks  
5. Chat with retrieval-aware agent  

Design: [`docs/superpowers/specs/2026-07-23-pi-rag-design.md`](docs/superpowers/specs/2026-07-23-pi-rag-design.md)

## Prerequisites

- Node.js 20+
- Docker (for Postgres)
- Optional: a running [RAGFlow](https://ragflow.io) instance + API key  
  Without RAGFlow, set `RAGFLOW_MOCK=true` (default in `.env.example`) to use an in-memory mock engine.

## Quick start

```bash
# 1) Postgres
docker compose up -d

# 2) Env
cp .env.example apps/api/.env
# edit apps/api/.env if needed

# 3) Install
npm install

# 4) DB schema
npm run db:push

# 5) Run API + Web (two terminals)
npm run dev:api
npm run dev:web
```

- Web: http://localhost:5173  
- API: http://localhost:3001/health  

Register a user in the UI, open **Knowledge**, create a KB, upload a `.txt`/`.md` file, **Parse**, **Preview**, then chat.

## Configuration

See [`.env.example`](.env.example).

| Variable | Meaning |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY` | Real RAGFlow instance |
| `RAGFLOW_MOCK` | `true` = local mock engine (no RAGFlow required) |
| `AUTH_ALLOW_REGISTER` | Allow self-registration |
| `OPENAI_API_KEY` | Optional; enables LLM tool-calling chat |
| `OPENAI_BASE_URL` / `OPENAI_MODEL` | OpenAI-compatible endpoint |

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
| `npm run db:push` | Prisma db push |
| `npm run db:migrate` | Prisma migrate dev |
| `npm run build` | Build api + web |
