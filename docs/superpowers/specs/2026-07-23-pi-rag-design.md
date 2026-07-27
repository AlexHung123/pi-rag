# CSB Knowledge Base Portal Design Spec

**Date:** 2026-07-23  
**Status:** Approved for planning  
**Product name:** CSB Knowledge Base Portal  
**Stack:** React (Vite) + NestJS + Postgres + RAGFlow + agent tools  

## 1. Problem & Goals

Build the **CSB Knowledge Base Portal** web product where each user can:

1. Create their own knowledge bases (datasets)
2. Upload documents
3. Trigger chunking (parse)
4. Preview documents and chunks
5. Chat with an agent that operates only on that user's knowledge

RAGFlow is the knowledge engine. NestJS is the only public API boundary. `pi-agent-core` runs server-side as the domain expert agent.

### Non-goals (MVP)

- RAGFlow console multi-tenancy / per-user RAGFlow API keys
- OIDC / SSO
- MCP, eval datasets, retrieval-debug panels, directory bulk upload (may come later)
- Complex RBAC beyond `user` / `admin`
- Browser direct access to RAGFlow

## 2. Product Decisions (Locked)

| Decision | Choice |
|----------|--------|
| UI form | Web app (chat + knowledge workspace), UX inspired by `ai-localbase` |
| Frontend | React + Vite + TypeScript |
| Backend | NestJS + TypeScript |
| Database | **Postgres** |
| Auth | **Simple multi-user** (register switch + login; optional admin bootstrap) |
| Isolation | NestJS ownership tables; service-account RAGFlow key |
| Agent | `@earendil-works/pi-agent-core` on server |
| Knowledge engine | RAGFlow HTTP API |
| ORM | **Prisma** |
| RAGFlow deploy | External instance via env (compose ships Postgres only for MVP) |

## 3. Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  apps/web  (React / Vite)                                   │
│  Login · Sidebar · ChatArea · KnowledgeWorkspace · Settings │
└──────────────────────────────┬──────────────────────────────┘
                               │ HttpOnly session cookie + CSRF
┌──────────────────────────────▼──────────────────────────────┐
│  apps/api  (NestJS)                                         │
│  Auth · Knowledge · Documents · Chat(SSE) · Users(admin)    │
│                                                             │
│  ┌──────────────┐  ┌────────────────┐  ┌─────────────────┐  │
│  │ Postgres     │  │ RagflowClient  │  │ Domain Agent    │  │
│  │ ownership +  │  │ upload/parse/  │  │ pi-agent-core   │  │
│  │ sessions +   │  │ chunks/preview │  │ tools(userId)   │  │
│  │ chat history │  └───────┬────────┘  └────────┬────────┘  │
└────────────────┴───────────┼────────────────────┼───────────┘
                             ▼                    ▼
                      ┌─────────────┐      ┌─────────────┐
                      │  RAGFlow    │      │  LLM (pi-ai)│
                      └─────────────┘      └─────────────┘
```

### Principles

1. Browser talks **only** to NestJS.
2. Every KB/document/conversation access runs `assertOwned(userId, resourceId)`.
3. Failed ownership checks return **404** (no existence leak).
4. RAGFlow IDs are stored server-side; clients use app UUIDs.
5. Agent tools are created per request with a bound `userId` closure.

## 4. Multi-user & Isolation

### Roles

| Role | Capabilities |
|------|----------------|
| `user` | Register (if enabled) or be created; full CRUD on own KBs/docs/chats |
| `admin` | Create/disable users; manage own data like a normal user (no automatic cross-user KB access in MVP) |

### Auth behavior

- `AUTH_ALLOW_REGISTER=true|false` (default `true` for MVP)
- Password hashing: bcrypt
- Sessions stored in Postgres; cookie is opaque token; DB stores **token hash only**
- Cookie: HttpOnly, SameSite=Lax, Secure in production
- CSRF: double-submit or synced cookie pattern for state-changing requests
- Optional first admin via env bootstrap (`ADMIN_USERNAME` / `ADMIN_PASSWORD`) on empty DB

### Isolation model

**Chosen:** NestJS security boundary + ownership tables (not per-user RAGFlow tenants).

- List endpoints: `WHERE owner_user_id = :currentUser`
- Mutation endpoints: load by id + owner check
- Agent tools call the same services (never raw RAGFlow with unchecked IDs)
- Deploy RAGFlow on private network; API key never exposed to browser

## 5. Data Model (Postgres / Prisma)

### `users`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| username | TEXT UNIQUE | |
| password_hash | TEXT | bcrypt |
| role | ENUM(`user`,`admin`) | |
| disabled_at | TIMESTAMPTZ NULL | |
| created_at / updated_at | TIMESTAMPTZ | |

### `sessions`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK | |
| token_hash | TEXT UNIQUE | sha256 of cookie token |
| csrf_secret | TEXT | |
| expires_at | TIMESTAMPTZ | |
| revoked_at | TIMESTAMPTZ NULL | |
| ip / user_agent | TEXT NULL | |
| created_at | TIMESTAMPTZ | |

### `knowledge_bases`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | Public app id |
| owner_user_id | UUID FK | |
| ragflow_dataset_id | TEXT UNIQUE | RAGFlow dataset id |
| name | TEXT | |
| description | TEXT | default `''` |
| chunk_method | TEXT | e.g. `naive`, `manual`, `laws` |
| parser_config | JSONB | |
| created_at / updated_at | TIMESTAMPTZ | |
| | | UNIQUE(owner_user_id, name) |

### `documents`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | Public app id |
| knowledge_base_id | UUID FK | |
| owner_user_id | UUID FK | denormalized for auth |
| ragflow_document_id | TEXT | |
| name | TEXT | |
| size_bytes | BIGINT | |
| status | ENUM(`unstart`,`running`,`done`,`fail`) | |
| progress | DOUBLE | 0..1 |
| progress_msg | TEXT NULL | |
| chunk_count | INT | default 0 |
| error_message | TEXT NULL | |
| created_at / updated_at | TIMESTAMPTZ | |

### `conversations` / `messages`

| Table | Key fields |
|-------|------------|
| conversations | id, owner_user_id, title, created_at, updated_at |
| messages | id, conversation_id, role (`user`\|`assistant`\|`tool`\|`system`), content, metadata JSONB, created_at |

### Indexes

- `knowledge_bases(owner_user_id)`
- `documents(knowledge_base_id)`, `documents(owner_user_id)`
- `sessions(token_hash)`, `sessions(user_id)`
- `conversations(owner_user_id)`, `messages(conversation_id)`

## 6. RAGFlow Mapping

| Product action | NestJS | RAGFlow |
|----------------|--------|---------|
| Create KB | `POST /api/knowledge-bases` | `POST /api/v1/datasets` |
| List KBs | `GET /api/knowledge-bases` | local DB only (owned) |
| Delete KB | `DELETE /api/knowledge-bases/:id` | delete dataset + local row |
| Upload doc | `POST /api/knowledge-bases/:id/documents` | `POST /api/v1/datasets/{dataset_id}/documents` |
| Parse / cut chunks | `POST .../documents/:docId/parse` | `POST /api/v1/datasets/{dataset_id}/chunks` body `{ document_ids }` |
| Doc status | `GET .../documents/:docId` | poll list/get document fields (`run`, `progress`, …) |
| Preview | `GET .../documents/:docId/preview` | list document meta + `GET .../documents/{id}/chunks` |
| Retrieve (P3) | agent tool / service | retrieve chunks API |

### Parse lifecycle

```text
upload → status=unstart
user triggers parse (or auto-parse config later)
  → POST RAGFlow parse
  → status=running
background/on-read poll RAGFlow
  → done | fail (progress, chunk_count, error_message)
frontend polls document list every ~2s while any running
```

**Note:** Upload does **not** auto-chunk in MVP unless explicitly configured later. UI exposes a clear "Parse / Cut chunks" action. Default recommendation for P2+: optional `autoParse: true` on upload.

### Preview definition

1. **Document preview:** name, size, status, progress, chunk_count, timestamps  
2. **Chunk preview:** paginated chunk content (`page`, `pageSize`, optional `keywords`)

## 7. HTTP API (MVP)

All `/api/*` except auth bootstrap/login/register require session.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create user (if allowed) |
| POST | `/api/auth/login` | Set session cookie |
| POST | `/api/auth/logout` | Revoke session |
| GET | `/api/auth/me` | Current principal |

### Knowledge bases

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/knowledge-bases` | List mine |
| POST | `/api/knowledge-bases` | `{ name, description?, chunkMethod?, parserConfig? }` |
| GET | `/api/knowledge-bases/:id` | Detail (owned) |
| DELETE | `/api/knowledge-bases/:id` | Delete owned + RAGFlow dataset |

### Documents

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/knowledge-bases/:id/documents` | List docs |
| POST | `/api/knowledge-bases/:id/documents` | multipart `file` |
| GET | `/api/knowledge-bases/:id/documents/:docId` | Status + meta |
| POST | `/api/knowledge-bases/:id/documents/:docId/parse` | Start chunking |
| GET | `/api/knowledge-bases/:id/documents/:docId/chunks` | Chunk list/preview |
| GET | `/api/knowledge-bases/:id/documents/:docId/preview` | Aggregated meta + first page chunks |
| DELETE | `/api/knowledge-bases/:id/documents/:docId` | Delete owned doc |

### Chat

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/conversations` | List mine |
| POST | `/api/conversations` | Create |
| GET | `/api/conversations/:id` | Detail + messages |
| DELETE | `/api/conversations/:id` | Delete |
| POST | `/api/conversations/:id/messages` | Body `{ content }` → **SSE** stream |

### Admin (optional P1 end)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/users` | admin creates user |
| PATCH | `/api/admin/users/:id` | disable/enable |

### Error shape

```json
{ "statusCode": 400, "message": "…", "error": "Bad Request" }
```

Ownership failures: `404` with generic not found message.

## 8. NestJS Module Layout

```text
apps/api/src
  auth/           # register, login, session guard, CSRF
  users/          # admin user ops
  knowledge/      # KB service + controller
  documents/      # upload, parse, preview
  chat/           # conversations + SSE
  ragflow/        # typed HTTP client
  agent/          # pi-agent-core factory + tools
  prisma/         # PrismaModule
  common/         # filters, interceptors, assertOwned helpers
```

### `RagflowClient` responsibilities

- Base URL + Bearer API key
- Normalize `{ code, data, message }` (`code !== 0` → throw)
- Methods: create/list/delete dataset; upload documents; parse; list documents; list/get chunks; retrieve
- Support `AbortSignal` for agent cancellation
- Multipart upload via form-data / undici

### `DomainAgent` responsibilities

- Build system prompt from domain profile (config/env)
- `createToolsForUser(userId)` → AgentTool[]
- Map agent events to SSE frames
- Never pass global RAGFlow key into tool results

### MVP tools

| Tool | Purpose |
|------|---------|
| `retrieve_chunks` | P3 RAG retrieval (user-selected KBs only) |

KB create/list/select, document list/upload/parse, and preview remain REST+UI only (not agent tools).

Upload remains primarily REST+UI for reliability and progress UX.

## 9. Frontend (React)

### Inspiration

Reference: `D:\Projects\ai-localbase\frontend` (running at `http://localhost:3000/`).

**Reuse patterns:** login flow, sidebar + main chat, knowledge rail, document list, upload dropzone, document detail/preview modal, design tokens, toast/confirm/empty states.

**Do not port in MVP:** eval datasets, retrieval debug, MCP settings, directory upload task panel.

### Routes / shell

```text
/login
/app
  Sidebar: conversations, new chat, open knowledge workspace
  ChatArea: markdown, SSE typing, later citations
  KnowledgeWorkspace (panel/drawer):
    - KB rail + create dialog
    - Document list + upload
    - Parse action + status badges
    - DocumentPreviewModal (meta + chunks)
```

### Tech

- Vite, React 18, TypeScript
- lucide-react, react-markdown, remark-gfm
- CSS design tokens (inspired by localbase `design-tokens.css` / layout CSS)
- `credentials: 'include'` for API; CSRF header on mutating requests

### Client types (mirror server)

`KnowledgeBase`, `DocumentItem` (`unstart|running|done|fail`), `Conversation`, `ChatMessage`.

## 10. Repository Layout

```text
pi-rag/
  apps/
    api/                 # NestJS
    web/                 # React Vite
  packages/
    shared/              # optional shared DTO/types
  docs/
    superpowers/
      specs/
        2026-07-23-pi-rag-design.md
  docker-compose.yml     # postgres
  .env.example
  README.md
  package.json           # npm workspaces or pnpm workspace
```

## 11. Configuration

```bash
# apps/api
DATABASE_URL=postgresql://pi_rag:pi_rag@localhost:5432/pi_rag
RAGFLOW_BASE_URL=http://localhost:9380
RAGFLOW_API_KEY=
AUTH_ALLOW_REGISTER=true
SESSION_TTL_DAYS=7
ADMIN_USERNAME=           # optional bootstrap
ADMIN_PASSWORD=
CORS_ORIGIN=http://localhost:5173
# LLM / pi-ai provider keys as needed
PORT=3001
```

## 12. Delivery Phases

| Phase | Scope | Acceptance |
|-------|-------|------------|
| **P0** | Monorepo, Postgres, Prisma, auth register/login, web shell | Two users have isolated sessions |
| **P1** | KB CRUD + ownership + RAGFlow dataset create/delete | User B cannot list/get User A's KB |
| **P2** | Upload, parse, status poll, chunk/document preview | Full 4-capability pipeline works end-to-end |
| **P3** | pi-agent-core chat SSE + retrieve tool + basic citations | Answers grounded in owned KB only |
| **P4** | Polish, admin create user, optional auto-parse, UX parity | Production-ready vertical expert UX |

## 13. Security Notes

- Rate-limit login/register
- Max upload size enforced in NestJS before proxying to RAGFlow
- Validate filenames; store original name as metadata only
- Do not log API keys or raw session tokens
- SSE auth via same session cookie
- Tool args validated with TypeBox / class-validator schemas

## 14. Testing Strategy

- Unit: ownership helper, RagflowClient error mapping, status mapping
- Integration: dual-user KB isolation against Postgres (testcontainers or compose)
- E2E (later): register A/B, create KB, upload fixture, parse mock/real, preview
- Agent: tool cannot accept another user's UUID (service throws 404)

## 15. Open Follow-ups (explicit defaults)

| Topic | Default for implementation |
|-------|----------------------------|
| Auto-parse on upload | **Off** in MVP; explicit button |
| Self-register | **On** via `AUTH_ALLOW_REGISTER` |
| Domain prompt | Single env/config profile v1 |
| Shared package | Optional; start with duplicated DTOs if faster, extract when stable |
| RAGFlow in compose | **Out of scope** for first compose; document external requirement |

## 16. Success Criteria (MVP complete = end of P2 + thin P3 chat)

1. User can register/login and only see own data.
2. User can create a knowledge base backed by RAGFlow dataset.
3. User can upload a document into that KB.
4. User can trigger chunking and observe terminal status.
5. User can preview document metadata and chunk text.
6. User can chat; agent tools cannot cross user boundaries.
7. Postgres is source of truth for ownership and app entities.
