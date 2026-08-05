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
- [`docs/superpowers/specs/2026-08-06-session-workspace-analyze-design.md`](docs/superpowers/specs/2026-08-06-session-workspace-analyze-design.md) — session workspace + analyze tools (knowledge problem solver)

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

### Audio upload → transcription → ingest

You can upload meeting recordings (mp3, m4a, wav, …) into a knowledge base. The API stores the audio locally, transcribes it via an **OpenAI-compatible STT service** (or mock), writes a timestamped Markdown transcript, then uploads that transcript to RAGFlow and auto-parses it. Chat/RAG only sees the transcript — never raw audio.

```bash
# apps/api/.env — local dev without STT
STT_MOCK=true
RAGFLOW_MOCK=true   # or real RAGFlow

# Real STT: FunASR SenseVoice (Cantonese-friendly) on LAN host
STT_MOCK=false
STT_BASE_URL=http://192.168.1.11:8002
STT_MODEL=sensevoice
STT_DEFAULT_LANGUAGE=yue   # Cantonese; use auto for mixed meetings
STT_WORKER_CONCURRENCY=1
# Default: review transcript in UI, then click Ingest (do not auto-push to RAGFlow)
STT_AUTO_INGEST=false
# Speaker labels (if FunASR supports spk=true)
STT_SPK=false
# Remote STT should convert video itself (recommended). Client-side ffmpeg off:
STT_CLIENT_TRANSCODE=false
```

Flow: upload audio/video → **one** `POST {STT_BASE_URL}/v1/audio/transcriptions`  
(remote: mp4→wav→SenseVoice) → **Review & ingest** → RAGFlow + parse → chat.

**Video:** Prefer a unified remote STT (e.g. `http://192.168.1.11:8002`) that accepts `.mp4` and runs ffmpeg in-process. pi-rag sends the original file; set `STT_CLIENT_TRANSCODE=true` only if the STT server cannot handle video.

If `STT_BASE_URL` is empty and `STT_MOCK` is false, **audio** uploads fail with a clear error; normal document uploads still work. See design: [`docs/superpowers/specs/2026-07-28-audio-transcription-ingest-design.md`](docs/superpowers/specs/2026-07-28-audio-transcription-ingest-design.md).

## Configuration

See [`.env.example`](.env.example).

| Variable | Meaning |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY` | Real RAGFlow instance |
| `RAGFLOW_MOCK` | `true` = in-memory mock (no RAGFlow). Production requires API key unless this is explicitly `true` |
| `STT_BASE_URL` / `STT_MOCK` | Local STT HTTP endpoint, or mock for dev |
| `MEDIA_ROOT` | Local disk root for original audio (default `data/media`) |
| `MAX_AUDIO_UPLOAD_BYTES` | Audio upload cap (default 1 GiB) |
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
