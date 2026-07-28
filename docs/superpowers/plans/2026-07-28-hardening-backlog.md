# Hardening Backlog Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` task-by-task. Checkboxes track progress.  
> **Status:** Implemented 2026-07-28 (B1 register UI + M1 bulk multi-select).  
> **Date:** 2026-07-28

**Goal:** Close the post–security-P0 backlog: concurrency correctness, abuse bounds, automated regression, schema migration discipline, and small UX honesty fixes.

**Architecture:** Keep Nest as the only public API. Prefer small, independently mergeable PRs. No god-component rewrite. Tests start on pure functions / guards / scope before full e2e.

**Tech Stack:** NestJS, Prisma/Postgres, React/Vite; tests: Vitest + Supertest (API); no new frontend framework.

**Out of scope (this plan):** Full App/KnowledgePanel split, Helmet suite, SSE abort (separate P1 security plan item), upload MIME allowlist (security PR3), login rate-limit (security PR4).

---

## Already done (do not redo)

- XSS: always escape in document preview / locate
- CSRF: header-only validation + frontend `requireCsrfToken`
- `LLM_DEBUG` gated; `apps/api/data/` gitignored
- RAGFlow mock: prod fail-fast; dev loud warning

---

## Recommended PR order

| PR | Name | Risk | Effort | Depends on |
|----|------|------|--------|------------|
| **A** | Chat MaxLength + delete try/catch + multi-select UX | Low | S | — |
| **B** | Register UI *or* remove dead register surface | Low | S | Product decision |
| **C** | Agent pool mutex (create / busy race) | Medium | M | — |
| **D** | Storage quota TOCTOU | Medium | M | — |
| **E** | Critical-path automated tests | Low–Med | M–L | Best after A–D so CSRF/pool/quota behavior is stable |
| **F** | Prisma migrate baseline | Medium (ops) | M | Coordinate with all envs |

**Suggested delivery waves**

1. **Wave 1 (UX honesty, 0.5–1 day):** PR A + PR B  
2. **Wave 2 (correctness, 1–2 days):** PR C + PR D  
3. **Wave 3 (safety net, 1–2 days):** PR E  
4. **Wave 4 (ops, half day + deploy discipline):** PR F  

Can parallelize C ∥ D, A ∥ B. E should land after C/D if tests cover those paths.

---

## File map (by workstream)

| Workstream | Primary files |
|------------|----------------|
| MaxLength | `apps/api/src/chat/chat.dto.ts`, optionally `chat.service.ts` hard cap; web `App.tsx` input maxLength |
| Agent pool | `apps/api/src/agent/agent-session.pool.ts`, maybe `agent.service.ts` |
| Quota TOCTOU | `apps/api/src/common/storage-quota.ts`, `documents.service.ts`, `admin.service.ts` (admin upload) |
| Tests | new `apps/api/vitest.config.ts`, `apps/api/test/**`, root/`api` package.json scripts |
| Prisma migrate | `apps/api/prisma/migrations/**`, README scripts, stop relying on `db:push` for shared envs |
| Register | `apps/web/src/components/Login.tsx`, `AuthContext.tsx` (already has register) |
| Delete errors | `apps/web/src/components/KnowledgePanel.tsx` (`onDeleteDoc`, `onDeleteKb`) |
| Multi-select | `KnowledgePanel.tsx` + existing `docApi` / optional batch API |

---

## Product decisions (must lock before PR B / multi-select)

### Decision 1 — Register

| Option | When to choose |
|--------|----------------|
| **B1 — Wire register UI** | Self-serve onboarding still wanted (`AUTH_ALLOW_REGISTER=true` in dev) |
| **B2 — Remove client dead API** | Registration only via admin; keep server register behind env for bootstrap scripts |

**Recommendation:** **B1** if MVP still uses open register; otherwise **B2** (hide client, keep server `POST /api/auth/register` when env allows).

### Decision 2 — Document multi-select

| Option | When to choose |
|--------|----------------|
| **M1 — Implement bulk Parse / Delete** | Checkbox already in UI; admin already has batch patterns |
| **M2 — Remove checkboxes** | No time for bulk; honesty > incomplete chrome |

**Recommendation:** **M1** for selected docs only (client-side sequential calls to existing endpoints is enough; no new batch API required for v1).

---

# PR A — Bounds + UX honesty

## A1. Chat message MaxLength

**Problem:** `PostMessageDto.content` only `@MinLength(1)` → huge body → DB bloat + LLM cost + pool memory.

**Approach**

1. API DTO:

```ts
// chat.dto.ts
@IsString()
@MinLength(1)
@MaxLength(32000) // or 16_000 — pick one constant
content!: string;
```

2. Shared constant e.g. `apps/api/src/chat/chat.limits.ts`:

```ts
export const CHAT_MESSAGE_MAX_CHARS = 32_000;
```

3. Service belt-and-suspenders: if content longer after trim, `badRequest` (in case validation bypassed).

4. Web: `maxLength={32000}` on chat textarea; optional character counter near limit (nice-to-have).

5. Title slice already exists; leave as-is unless title DTO lacks max.

**Done when**

- POST with 33k chars → 400  
- Normal chat still works  
- Constant is single source of truth for API

**Test (manual):** oversized message rejected; 100-char message OK.

---

## A2. Delete KB / Doc error handling

**Problem:** `onDeleteDoc` / `onDeleteKb` in `KnowledgePanel.tsx` use `confirm` + `await` without try/catch → unhandled rejection; UI desync.

**Approach**

```ts
const onDeleteDoc = async (docId: string) => {
  if (!confirm(...)) return;
  setError('');
  setBusy(true); // or per-row busy if exists
  try {
    await docApi.remove(kbId, docId);
    // refresh list / clear selection
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  } finally {
    setBusy(false);
  }
};
```

Same pattern for `onDeleteKb`. Clear `selectedDocIds` when deleted id was selected.

**Done when**

- Failed delete shows error in panel, no console unhandled rejection  
- Successful delete still refreshes list

---

## A3. Document multi-select (M1 recommended)

**Problem:** `selectedDocIds` + checkboxes, no bulk actions.

**Approach (no new backend)**

1. Toolbar when `selectedDocIds.size > 0` and `canEditContent`:

   - **Parse selected** — sequential `docApi.parse` for `unstart`/`fail` only; skip `running`/`done` with summary toast/text  
   - **Delete selected** — one `confirm` with count; sequential `docApi.remove`; stop on first hard error or continue-and-report  

2. Disable bulk actions while busy; show progress `3/10`.

3. Select-all only applies to **filtered** docs (current list).

4. If product picks **M2** instead: delete `selectedDocIds` state and all checkbox UI.

**Done when**

- Bulk parse/delete works for editor/owner  
- Viewer does not see bulk destructive actions  
- Empty selection hides toolbar

---

# PR B — Register UI or dead API cleanup

## B1. Wire register (recommended if open registration)

**Files:** `Login.tsx`, styles if needed.

**Approach**

1. Use `allowRegister` from `useAuth()`.  
2. Toggle “Create account” / “Sign in” mode on same card.  
3. `register(username, password)` then auto-session (API already logs in after register).  
4. Hide register path when `allowRegister === false`.  
5. Align min password length with server (currently 6; if later raised, match).

**Done when**

- `AUTH_ALLOW_REGISTER=true` → UI can register  
- `false` → only login  

## B2. Remove dead client surface

1. Remove `register` from `AuthContext` public API (or keep unused private).  
2. Remove unused imports.  
3. Document: admin creates users.

---

# PR C — Agent pool create / busy race

**Problem (current):** `AgentSessionPool.acquire` in `agent-session.pool.ts`:

1. Two concurrent first messages for same `conversationId` can both miss `sessions.get`, both `createAgent`, second `set` orphans first agent (leak).  
2. `waitUntilIdle` polls `busy`; two waiters can both observe `busy === false` and both set `busy = true` → overlapping `prompt()`.

**Approach — per-conversation serial queue**

```ts
// Conceptual — keep Map of conversationId → Promise chain
private readonly tails = new Map<string, Promise<unknown>>();

private enqueue<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = this.tails.get(conversationId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run even if prev failed
  this.tails.set(
    conversationId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async acquire(...): Promise<AgentSession> {
  return this.enqueue(conversationId, async () => {
    this.evictExpired();
    // existing userId mismatch dispose
    // create if missing (only one creator now)
    // waitUntilIdle still useful if busy set outside enqueue — prefer:
    if (session.busy) {
      // should not happen if all prompt paths use enqueue+release
      throw or wait with timeout
    }
    session.busy = true;
    session.lastUsedAt = Date.now();
    return session;
  });
}
```

**Stronger invariant**

- All acquire→prompt→release for a conversation stays inside one serial chain **or**  
- `busy` is only set/cleared inside the same enqueue critical section as create.

**Optional:** `release` only clears busy; dispose removes tail entry after idle.

**Also check:** `AgentService.run` `finally { release }` — ensure release is never skipped without dispose.

**Done when**

- Concurrent double-send same conversation: second waits or clear error; only one live agent in map  
- No orphan agents under forced parallel `acquire` (unit test with mock `createAgent` counter)  
- Pool full / TTL behavior unchanged  

**Manual test:** spam Send twice quickly on same chat; no crash; replies coherent or second gets “busy” only if intentionally rejecting.

---

# PR D — Storage quota TOCTOU

**Problem:** `assertWithinStorageQuota` then RAGFlow upload then Prisma insert — concurrent uploads all pass check → sum exceeds quota.

**Approach — advisory lock per user (Postgres) around check + remote upload + insert**

1. Add helper in `storage-quota.ts`:

```ts
export async function withUserStorageLock<T>(
  prisma: PrismaService,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // hash userId to int4 pair for pg_advisory_lock
  await prisma.$executeRaw`SELECT pg_advisory_lock(${key1}, ${key2})`;
  try {
    return await fn();
  } finally {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${key1}, ${key2})`;
  }
}
```

2. Wrap `DocumentsService.upload` body:

```ts
return withUserStorageLock(this.prisma, userId, async () => {
  await assertWithinStorageQuota(...);
  const uploaded = await this.ragflow.uploadDocuments(...);
  // insert document row
});
```

3. Same for admin upload that charges a user.

**Caveats**

- Holds lock during RAGFlow network I/O → slower concurrent uploads for **same user** (acceptable).  
- Different users no contention.  
- Mock mode still uses same path.  
- If process crashes mid-lock, session-end unlocks (transaction-scoped alternative: `pg_advisory_xact_lock` inside a longer interactive transaction — harder with external HTTP). Prefer session lock + try/finally.

**Alternative (heavier):** `storage_reservations` table with TTL — only if advisory locks prove insufficient (multi-DB, non-Postgres).

**Done when**

- Two parallel max-quota-filling uploads for same user: one succeeds, one 400  
- Sequential uploads still correct  
- Usage UI after both settles ≤ quota  

---

# PR E — Critical-path automated tests

**Problem:** Zero automated tests; CSRF, ownership, scope, admin regressions silent.

**Approach — introduce Vitest + Supertest on API only (first)**

### E0. Scaffold

- `apps/api` devDeps: `vitest`, `supertest`, `@types/supertest`  
- Script: `"test": "vitest run"`, `"test:watch": "vitest"`  
- Config: Node environment, path aliases if needed  
- Prefer **unit tests without full Nest boot** for pure modules; **light Nest testing module** for guards  

### E1. Pure unit (fast, no DB)

| Target | Cases |
|--------|--------|
| `resolveRetrievalScope` / `resolveDocumentScope` | empty ids fail; foreign id fail; public/shared readable mock prisma |
| `assertWithinStorageQuota` | under/over quota (mock aggregate) |
| CSRF comparison helper if extracted | header required |

Use dependency injection with fake `KnowledgeService` / `PrismaService`.

### E2. AuthGuard (Nest TestingModule)

- Mock `AuthService.resolveSession`  
- GET without session → 401 path via guard throw  
- POST with session, no CSRF header → forbidden  
- POST with matching header → ok  

No real cookie parser required if request object is synthetic.

### E3. Ownership integration (optional second step)

- Requires test Postgres or Testcontainers  
- Skip in CI if no `DATABASE_URL_TEST`  
- Seed two users, assert cross-user conversation/KB → 404  

**Minimum bar for merge of E:** E0 + E1 + E2 green on developer machine without Docker RAGFlow.

**Done when**

- `npm test -w @pi-rag/api` exits 0  
- README: how to run tests  
- At least: CSRF header required; scope fail-closed; quota over reject  

---

# PR F — Prisma migrate (replace ad-hoc push for shared envs)

**Problem:** No `prisma/migrations`; `db push` works solo, breaks team/prod history.

**Approach — baseline existing schema**

1. Ensure local DB matches `schema.prisma` (`db push` once if needed).  
2. Create baseline migration:

```bash
cd apps/api
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql
# or: prisma migrate dev --name init  on empty DB
```

3. For **already-existing** databases that were push-managed:

```bash
npx prisma migrate resolve --applied 0_init
```

Document in README:

| Env | Command |
|-----|---------|
| Fresh | `prisma migrate deploy` |
| Dev iterate | `prisma migrate dev` |
| Legacy push-only DB | baseline + `migrate resolve` once |

4. Root scripts: keep `db:push` as **escape hatch**, prefer `db:migrate` in README Quick start for teams.

5. CI (if any): `migrate deploy` before tests.

**Done when**

- `prisma/migrations/` exists and applies clean on empty Postgres  
- README documents baseline for existing deploys  
- Team agrees push is local-only  

**Risk:** Coordinate so nobody `db push`s a drift that migrations don’t include.

---

## Cross-cutting standards

1. **No drive-by refactors** outside the PR’s file map.  
2. **Constants** for limits (message max, bulk concurrency).  
3. **Errors:** user-facing via existing `badRequest` / panel `error-text`.  
4. **Commits:** one logical commit per PR or per A1/A2/A3 if preferred.  
5. **Do not** enable `LLM_DEBUG` in tests.

---

## Verification matrix (before claiming a wave done)

| Wave | Commands / checks |
|------|-------------------|
| 1 | Manual UI: delete fail path, bulk ops, register toggle; API 400 on long message |
| 2 | Parallel acquire script or unit test; parallel upload quota |
| 3 | `npm test -w @pi-rag/api` |
| 4 | Empty DB migrate deploy; app boots |

| Always | `npm run build -w @pi-rag/api` and `-w @pi-rag/web` |

---

## Explicit non-goals (remind)

- Rate limit / upload MIME / SSE abort → security plan PR3–5  
- Split KnowledgePanel / App god components → later maintainability plan  
- Changing public KB semantics  

---

## Execution handoff

After approval of:

1. Register **B1 vs B2**  
2. Multi-select **M1 vs M2**  
3. Wave start (**1 only** vs **1+2**)  

Implement with subagent-driven or inline execution, **one PR/wave at a time**, no code until then if owner wants review-only.

**Plan saved to:** `docs/superpowers/plans/2026-07-28-hardening-backlog.md`
