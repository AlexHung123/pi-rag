# Admin RAGFlow Monitor Tabs — Design Spec

**Date:** 2026-07-27  
**Status:** Approved for implementation  
**Approach:** A — dedicated Admin module + AdminGuard + four admin-only workspaces  
**Reference:** [ragflow-admin](https://github.com/) UI (`docs/images/datasets.jpg`, `documents.jpg`, `tasks.jpg`, `users.png`)

## Problem

pi-rag isolates knowledge bases and documents per owner. Operators with the `admin` role need a cross-user monitor and management console for:

1. All knowledge bases (datasets)
2. Documents within a dataset
3. Global parsing task queue
4. Portal users

These views must not be visible or callable by non-admin users.

## Goals

- Four admin-only workspace tabs: **Datasets**, **Documents**, **Tasks**, **Users**
- Full management parity with ragflow-admin where it maps cleanly onto pi-rag data
- Data from **pi-rag Postgres + existing RagflowService** (no RAGFlow MySQL dependency)
- Enforce `role === 'admin'` on both UI and `/api/admin/*` APIs
- Leave existing owner-scoped Chat / Knowledge paths unchanged

## Non-goals

- Direct RAGFlow MySQL access (ragflow-admin style)
- Separate RAGFlow account management (email/nickname/superuser from RAGFlow DB)
- Embedding or proxying the ragflow-admin SPA
- Ant Design UI; stay within CSB portal styling
- Chat / Agents / Settings pages from ragflow-admin (out of scope)

## Access control

### Roles

| Role  | Chat | Knowledge (own) | Admin tabs |
|-------|------|-----------------|------------|
| user  | yes  | yes             | no         |
| admin | yes  | yes             | yes        |

### Enforcement

1. **Frontend:** Rail shows the four admin entries only when `user.role === 'admin'`. Non-admins never mount admin panels.
2. **Backend:** All `/api/admin/*` routes use `AuthGuard` then `AdminGuard`. Non-admin → **403** with a clear message.
3. **CSRF:** Mutations keep the existing session CSRF rules.

### Safety rules (Users)

- Cannot disable or delete the currently authenticated admin session user (self-lockout prevention).
- Cannot demote, disable, or delete the **last remaining** admin.
- Password reset requires a non-empty password meeting the same rules as registration.

## Navigation

Admin-only items on the existing left rail (below Knowledge):

| Workspace id   | Label      | Icon intent        |
|----------------|------------|--------------------|
| `admin-datasets`  | Datasets  | database / folder  |
| `admin-documents` | Documents | file list          |
| `admin-tasks`     | Tasks     | list / queue       |
| `admin-users`     | Users     | users              |

`WorkspaceView` extends to include these four ids. Switching away from chat keeps conversation sidebar behavior unchanged (conversation panel only for `chat`).

### Documents selection flow

- Opening **Documents** without a selected dataset shows an empty state: “Select a dataset from Datasets.”
- Clicking a row on **Datasets** sets `adminSelectedDatasetId` (+ name) and switches workspace to `admin-documents`.
- Documents header has a **Back** control that returns to Datasets.

## Page specifications

### 1. Datasets

Cross-user list of `KnowledgeBase` rows joined with owner and document aggregates.

**Toolbar**

- Search by name
- Search by owner (username)
- Filter by chunk method (`naive`, `manual`, `qa`, …)
- Search / Refresh
- Batch Delete (selected rows)

**Columns**

| Column       | Source |
|--------------|--------|
| Name         | `KnowledgeBase.name` |
| Docs         | count of `Document` for KB |
| Chunks       | sum of `Document.chunkCount` |
| Chunk method | `KnowledgeBase.chunkMethod` |
| Owner        | `User.username` |
| Created      | `KnowledgeBase.createdAt` |
| Actions      | Delete |

**Actions**

- Single delete / batch delete: delete RAGFlow dataset via `RagflowService.deleteDatasets`, then cascade-remove local KB (and docs) in Postgres. Prefer transaction: best-effort RAGFlow delete then Prisma delete, same spirit as current owner path.
- Row click → open Documents for that KB.

### 2. Documents

Documents for one knowledge base (`adminSelectedDatasetId`), regardless of owner.

**Toolbar**

- Search by filename
- Filter by status (`unstart` | `running` | `done` | `fail`; map UI labels Unstart / Running / Done / Fail / Canceled if needed — portal has no `cancel` today; show only statuses that exist)
- Upload, Parse (selected parseable), Stop (selected running), Refresh, Batch Delete

**Columns**

| Column   | Source |
|----------|--------|
| Name     | `Document.name` |
| Size     | `sizeBytes` |
| Chunks   | `chunkCount` |
| Tokens   | omit or `—` if not stored (portal has no token count) |
| Progress | `progress` (0–1 → percent bar) |
| Status   | `status` |
| Created  | `createdAt` |
| Actions  | Delete |

**Actions**

- Upload / parse / stop / delete use admin services that load KB by id (no owner check), then call existing `RagflowService` + Prisma updates using the document’s `ownerUserId` / `ragflowDocumentId` as stored.
- Auto-refresh every ~3s while any row is `running`.

### 3. Tasks (Document Parsing Tasks)

Global view of all documents treated as parsing tasks (portal has no separate Task table).

**Summary cards**

- Total, Running, Unstart, Completed (`done`), Failed (`fail`), Canceled (always 0 unless status is added later)

**Toolbar**

- Search document name, dataset name, owner username
- Filter status
- Parse selected (unstart/fail), Stop selected (running), Retry all failed, Refresh

**Columns**

| Column   | Source |
|----------|--------|
| Document | `Document.name` |
| Dataset  | KB name |
| Size     | `sizeBytes` |
| Progress | `progress` |
| Status   | `status` |
| Queue    | `—` (not tracked in portal) |
| Duration | `—` or derived if process timestamps exist (omit if unavailable) |
| Chunks   | `chunkCount` |
| Owner    | username |
| Updated  | `updatedAt` |

**Actions**

- Batch parse/stop: group by `knowledgeBaseId`, call RAGFlow parse/stop per dataset, update Prisma.
- Retry failed: all docs with `status === fail` (or selected scope: all failed globally as in reference).

Auto-refresh while any task is `running`.

### 4. Users (Portal user admin)

**Toolbar**

- Search by username
- Filter Active / Inactive (`disabledAt` null vs set)
- Create User, Refresh, Delete Selected

**Columns**

| Column        | Source |
|---------------|--------|
| Username      | `User.username` |
| Datasets      | count KBs |
| Documents     | count docs |
| Conversations | count conversations |
| Status        | Active if `disabledAt == null` |
| Admin         | Yes if `role === admin` |
| Created       | `createdAt` |
| Actions       | Reset password, Delete |

**Actions**

- Create user: username + password (+ optional role default `user`)
- Toggle Active/Inactive: set/clear `disabledAt` (respect safety rules)
- Toggle Admin: set `role` user/admin (respect last-admin rule)
- Reset password: set new password hash
- Delete / batch delete: cascade sessions and owned data via Prisma relations; also delete RAGFlow datasets for owned KBs when practical

## Backend API

Base path: `/api/admin`  
Guards: `AuthGuard` + `AdminGuard`

### Datasets

| Method | Path | Description |
|--------|------|-------------|
| GET | `/datasets` | Query: `page`, `pageSize`, `name`, `owner`, `chunkMethod` → `{ items, total }` |
| POST | `/datasets/batch-delete` | Body: `{ ids: string[] }` |

### Documents

| Method | Path | Description |
|--------|------|-------------|
| GET | `/datasets/:kbId/documents` | Query: `page`, `pageSize`, `keywords`, `status` |
| POST | `/datasets/:kbId/documents/upload` | multipart file |
| POST | `/datasets/:kbId/documents/parse` | `{ documentIds: string[] }` |
| POST | `/datasets/:kbId/documents/stop-parse` | `{ documentIds: string[] }` |
| POST | `/datasets/:kbId/documents/batch-delete` | `{ ids: string[] }` |

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tasks` | Query: filters + pagination over all documents |
| GET | `/tasks/stats` | `{ total, running, unstart, done, fail, cancel }` |
| POST | `/tasks/batch-parse` | `{ tasks: { knowledgeBaseId, documentIds }[] }` |
| POST | `/tasks/batch-stop` | same shape |
| POST | `/tasks/retry-failed` | retry all failed (optional body later) |

### Users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/users` | Query: `page`, `pageSize`, `keyword`, `status` (`active`\|`inactive`) |
| POST | `/users` | Create `{ username, password, role? }` |
| PATCH | `/users/:id/status` | `{ disabled: boolean }` |
| PATCH | `/users/:id/role` | `{ role: 'user' \| 'admin' }` |
| PATCH | `/users/:id/password` | `{ password: string }` |
| POST | `/users/batch-delete` | `{ ids: string[] }` |

Response field naming: camelCase JSON consistent with existing portal APIs.

## Frontend structure

```
apps/web/src/
  components/
    admin/
      AdminDatasetsPanel.tsx
      AdminDocumentsPanel.tsx
      AdminTasksPanel.tsx
      AdminUsersPanel.tsx
      adminShared.tsx          # table chrome, status tags, formatters
  services/api.ts             # adminApi namespace
  components/AppSidebar.tsx   # admin rail items when role=admin
  App.tsx                     # workspace switch + selected dataset state
```

Styles live in existing `styles/index.css` under an `admin-*` prefix so tables match portal density without Ant Design.

## Module layout (API)

```
apps/api/src/admin/
  admin.module.ts
  admin.guard.ts
  admin-datasets.controller.ts / .service.ts
  admin-documents.controller.ts / .service.ts
  admin-tasks.controller.ts / .service.ts
  admin-users.controller.ts / .service.ts
  admin.dto.ts
```

Register `AdminModule` in `AppModule`. Reuse `PrismaService`, `RagflowService`, password hashing from `AuthService` / `common/crypto`.

## Data flow

```
Admin UI  →  /api/admin/*  →  AdminGuard  →  Admin*Service
                                              ├─ Prisma (cross-owner reads/writes)
                                              └─ RagflowService (dataset/doc/parse ops)
```

Non-admin UI never calls these endpoints. Owner-scoped `/api/knowledge-bases` and `/api/documents` remain the path for normal users.

## Error handling

- 401 unauthenticated (existing)
- 403 non-admin or CSRF failure
- 404 missing dataset/document/user
- 400 validation (empty ids, weak password, last-admin violation)
- Surface `message` string to UI error banners / toasts

## Testing / verification

1. Login as non-admin: no admin rail icons; direct `GET /api/admin/datasets` → 403.
2. Login as bootstrapped admin: four tabs visible.
3. Datasets lists KBs from multiple users; delete removes RAGFlow dataset + local row.
4. Documents upload/parse/stop for another user’s KB works for admin.
5. Tasks stats match document status counts; retry failed moves fail → running/unstart per engine.
6. Users: create, toggle disable, reset password, promote/demote; last-admin protected.
7. Mock mode (`RAGFLOW_MOCK=true`) still works for admin delete/parse paths.

## Implementation notes

- Prefer pagination at the DB layer (`skip`/`take` + `count`).
- Document status refresh: reuse existing refresh-from-RAGFlow logic from `DocumentsService` where possible (extract shared helper if needed rather than duplicating).
- Tokens column: display `—` (not stored).
- Queue position / duration: display `—` unless cheap to derive later.
- Chunk method filter options align with create-KB options already used in Knowledge panel.

## Open decisions (resolved)

| Decision | Choice |
|----------|--------|
| Capability level | Full management |
| Data source | pi-rag Postgres + RagflowService |
| Users model | Portal users (username / role / disabledAt) |
| Architecture | Dedicated Admin module (Approach A) |
