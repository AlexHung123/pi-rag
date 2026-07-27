# Knowledge Base Visibility & Sharing Design

**Date:** 2026-07-27  
**Status:** Approved  
**Scope:** Private/public visibility for knowledge bases (v1), with a member/role model ready for per-user sharing (later)

## Problem

Today every knowledge base is strictly owner-scoped:

- List, get, documents, and chat retrieval all filter by `ownerUserId`.
- There is no way to publish a KB for other logged-in users or to share with specific users later.

Users need:

1. **v1:** When creating a KB, choose **private** (owner only) or **public** (all authenticated users can use it).
2. **Later:** Owner shares a KB with specific users as **viewer** or **editor**.

## Goals

- Create-time and post-create control of `private` | `public`.
- Default remains **private** for new and existing KBs.
- Public = **use only** for non-owners: list, open, preview documents, chat retrieval.
- Only the owner manages the KB: visibility, delete KB, and (until shares exist) all document mutations.
- Single access-resolution path that can later include per-user roles without rewriting list/chat/document checks.
- Schema supports `viewer` / `editor` members now; invite UI and member APIs are **out of v1**.

## Non-goals (v1)

- Per-user share/invite UI or member CRUD APIs.
- Unauthenticated (anonymous) access.
- Org/team/workspace ACLs.
- Changing RAGFlow dataset permissions (app-layer ACL only; RAGFlow remains backend storage).
- Transferring ownership.

## Approach

**Hybrid: visibility flag + member table with roles.**

| Piece | Purpose |
|--------|---------|
| `visibility: private \| public` | Simple “everyone authenticated” switch |
| `KnowledgeBaseMember` + `role: viewer \| editor` | Future owner→user sharing |

Alternatives rejected:

- **Visibility only** — blocks clean per-user sharing later.
- **Members only (no public flag)** — awkward “public” representation and heavier list queries for the common case.

## Access model

Effective permissions for a user on a KB:

| Capability | Owner | Public (any logged-in user) | Shared **viewer** (later) | Shared **editor** (later) |
|------------|-------|-----------------------------|---------------------------|---------------------------|
| List / open / preview docs / chat retrieve | yes | yes | yes | yes |
| Upload / parse / stop / delete documents | yes | no | no | yes |
| Delete KB, change visibility, manage members | yes | no | no | no |

**Resolution order (helpers):**

1. `canAdmin(user, kb)` → `userId === ownerUserId`
2. `canEditContent(user, kb)` → admin **or** member with `role === editor`
3. `canRead(user, kb)` → admin **or** `visibility === public` **or** any membership row

v1 behavior:

- `canEditContent` is effectively owner-only (no member rows yet).
- `canRead` is owner or public.
- Document write paths use `canEditContent` (or explicit admin until editors exist—prefer `canEditContent` so editors work when added).
- List returns KBs where `canRead` would pass: owned **or** public (**or**, later, shared with me).

**“Everyone”** means all authenticated users. Existing `AuthGuard` remains; no anonymous routes.

## Data model

```prisma
enum KnowledgeBaseVisibility {
  private
  public
}

enum KnowledgeBaseRole {
  viewer
  editor
}

model KnowledgeBase {
  id               String                   @id @default(uuid()) @db.Uuid
  ownerUserId      String                   @map("owner_user_id") @db.Uuid
  ragflowDatasetId String                   @unique @map("ragflow_dataset_id")
  name             String
  description      String                   @default("")
  chunkMethod      String                   @default("naive") @map("chunk_method")
  parserConfig     Json                     @default("{}") @map("parser_config")
  visibility       KnowledgeBaseVisibility  @default(private)
  createdAt        DateTime                 @default(now()) @map("created_at")
  updatedAt        DateTime                 @updatedAt @map("updated_at")

  owner     User                  @relation(...)
  documents Document[]
  members   KnowledgeBaseMember[]

  @@unique([ownerUserId, name])
  @@index([ownerUserId])
  @@index([visibility])
  @@map("knowledge_bases")
}

model KnowledgeBaseMember {
  id              String            @id @default(uuid()) @db.Uuid
  knowledgeBaseId String            @map("knowledge_base_id") @db.Uuid
  userId          String            @map("user_id") @db.Uuid
  role            KnowledgeBaseRole @default(viewer)
  createdAt       DateTime          @default(now()) @map("created_at")
  updatedAt       DateTime          @updatedAt @map("updated_at")

  knowledgeBase KnowledgeBase @relation(fields: [knowledgeBaseId], references: [id], onDelete: Cascade)
  user          User          @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([knowledgeBaseId, userId])
  @@index([userId])
  @@map("knowledge_base_members")
}
```

**Migration notes:**

- Add `visibility` with default `private` so existing rows stay private.
- Create `knowledge_base_members` empty; no backfill required.
- Owner must not need a member row (ownership is via `ownerUserId`).
- Reject adding owner as a member in future member APIs (validation rule, not v1).

## API changes (v1)

### Types / serialization

KB JSON includes:

| Field | Notes |
|-------|--------|
| `visibility` | `"private"` \| `"public"` |
| `ownerUserId` | Always present |
| `ownerUsername` | Optional but recommended for non-owned rows in list UI |
| `isOwner` | `ownerUserId === currentUser` |
| `myRole` | Optional: `"owner"` \| `"viewer"` \| `"editor"` for UI (v1: owner or viewer-if-public) |

### Endpoints

| Method | Path | Auth | Behavior |
|--------|------|------|----------|
| `GET` | `/api/knowledge-bases` | user | Readable KBs: owned ∪ public (∪ shared later) |
| `POST` | `/api/knowledge-bases` | user | Create; body may include `visibility` (default `private`) |
| `GET` | `/api/knowledge-bases/:id` | user | `canRead` or 404 |
| `PATCH` | `/api/knowledge-bases/:id` | user | **Owner only.** Body: `{ visibility?: "private" \| "public" }` (extensible later for name/description) |
| `DELETE` | `/api/knowledge-bases/:id` | user | **Owner only** (unchanged policy) |

### Documents

Replace ownership-only checks with:

| Operation | Required |
|-----------|----------|
| list, get, preview, chunks, download file | `canRead` |
| upload, parse, stop-parse, delete | `canEditContent` |

Document rows may still store `ownerUserId` as uploader/creator; listing for a shared/public KB must not filter documents to only the current user’s `ownerUserId` when the caller can read the KB. **v1 fix:** list documents by `knowledgeBaseId` after `canRead`, not `knowledgeBaseId + ownerUserId`.

### Chat / agent retrieval

- Chat multi-select list uses the same readable KB set as `GET /api/knowledge-bases`.
- Agent `search_knowledge` (or equivalent) must resolve selected IDs via **readable** KBs, not only owned ones.
- Retrieval against RAGFlow uses the KB’s `ragflowDatasetId` after app-layer authorization succeeds.

### Member APIs (later, not v1)

- `GET/POST /api/knowledge-bases/:id/members`
- `PATCH/DELETE /api/knowledge-bases/:id/members/:userId`
- Owner-only; roles `viewer` | `editor`.

### Admin

Admin dataset monitor may show `visibility` for ops visibility; no change to admin’s global access model required for v1.

## UI changes (v1)

### Create knowledge base modal

- Control: **Private** / **Public** (radio or segmented control).
- Default: **Private**.
- Short helper text:
  - Private: only you can access this knowledge base.
  - Public: any logged-in user can use it in chat and view documents; only you can manage content.

### Knowledge base list

- Badge: Private / Public.
- For KBs you do not own: show owner username (or “Shared” later).
- Delete only when `isOwner`.
- Selecting a non-owned public KB opens detail in read-only manage mode (no upload/delete).

### Knowledge base detail

- Owner: toggle visibility (PATCH); full document toolbar.
- Non-owner (public/viewer): hide upload, parse controls, document delete, KB delete; allow browse/preview.
- Non-owner editor (later): show document mutation controls; hide KB delete and visibility/member admin.

### Chat

- KB picker lists all readable KBs (owned + public).
- Labels/badges so users can distinguish own vs public.

## Implementation plan outline

1. Prisma: enums, `visibility`, `KnowledgeBaseMember`, migrate.
2. `KnowledgeService`: access helpers; list/get/create/patch/remove; serialize new fields.
3. Documents: `canRead` / `canEditContent`; fix list filter so public readers see all docs in the KB.
4. Agent tools: retrieval over readable selected KBs.
5. Web: types, create form, list badges, detail toggle + read-only mode, chat picker.
6. Manual verification matrix (below).

## Testing / verification

| Case | Expected |
|------|----------|
| Create private (default) | Only owner sees in list; other users cannot get/retrieve |
| Create public | Other users see in list, open, preview, select in chat |
| Non-owner public | Cannot upload/delete docs or delete KB; cannot PATCH visibility |
| Owner toggles public → private | Others lose access immediately |
| Owner toggles private → public | Others gain read/use access |
| Chat retrieval on public KB | Other users get hits when that KB is selected |
| Existing KBs after migrate | Remain private |
| Member table | Exists; no UI/API in v1 |

## Security notes

- Never trust client-only hiding of manage buttons; enforce on every write endpoint.
- 404 (not 403) for inaccessible private KBs is acceptable to avoid ID enumeration; consistency with current `notFound` patterns preferred.
- Public does not expose RAGFlow credentials; only app-proxied document/retrieve operations after `canRead`.

## Future work (post-v1)

1. Share dialog: pick user + role; member CRUD APIs.
2. List sections/filters: Mine / Shared with me / Public.
3. Optional notifications when shared.
4. Revoke share; prevent self-share as owner.
5. Optional: name uniqueness rules if public names collide in UX (DB uniqueness remains per-owner).

## Success criteria

- Users can set private or public at create time and change visibility later.
- Public KBs are usable (list, docs preview, chat) by any logged-in user; content management remains owner-only in v1.
- Schema and access helpers are ready for viewer/editor sharing without redesigning list/chat/document authorization.
