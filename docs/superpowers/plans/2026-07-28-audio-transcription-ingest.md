# Audio Upload → Transcribe → Ingest — Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.  
> Prefer finishing **P0** end-to-end before P1/P2.

**Goal:** Let users upload audio into a knowledge base; Nest enqueues a DB-backed transcription job; a local STT service produces a timestamped Markdown transcript; the transcript is ingested via existing RAGFlow upload + auto-parse so chat/RAG works unchanged.

**Architecture:** Browser → Nest only. Audio stored under `MEDIA_ROOT`. `transcription_jobs` + in-process worker (`FOR UPDATE SKIP LOCKED`, concurrency default 1). STT is an external OpenAI-compatible HTTP service. RAGFlow never receives raw audio.

**Tech stack:** NestJS, Prisma/Postgres, multer, existing RagflowService, React Knowledge UI.

**Spec:** [`../specs/2026-07-28-audio-transcription-ingest-design.md`](../specs/2026-07-28-audio-transcription-ingest-design.md)  
**This plan:** `docs/superpowers/plans/2026-07-28-audio-transcription-ingest.md`

**Suggested branch:** `feat/audio-transcription-ingest`

---

## File map (P0)

| Path | Action | Role |
|------|--------|------|
| `apps/api/prisma/schema.prisma` | Edit | `sourceType`, media fields, nullable `ragflowDocumentId`, `TranscriptionJob` |
| `apps/api/prisma/migrations/*` | Add | Migration for above |
| `apps/api/src/transcription/transcription.module.ts` | Create | Module wiring |
| `apps/api/src/transcription/media-storage.ts` | Create | Paths, write/delete under `MEDIA_ROOT` |
| `apps/api/src/transcription/stt.client.ts` | Create | HTTP client + segment normalize + mock |
| `apps/api/src/transcription/transcript-format.ts` | Create | Markdown builder from segments |
| `apps/api/src/transcription/transcription.service.ts` | Create | enqueue / cancel / retry |
| `apps/api/src/transcription/transcription.worker.ts` | Create | Claim loop + pipeline stages |
| `apps/api/src/transcription/audio-formats.ts` | Create | Extension/mime allowlist |
| `apps/api/src/app.module.ts` | Edit | Import `TranscriptionModule` |
| `apps/api/src/documents/documents.service.ts` | Edit | Branch upload; serialize; delete/cancel hooks; list refresh |
| `apps/api/src/documents/documents.controller.ts` | Edit | Language field; cancel/retry; disk storage for audio if needed |
| `apps/api/src/documents/documents.module.ts` | Edit | Import/export transcription deps |
| `apps/api/src/admin/*` | Edit if needed | Null-safe `ragflowDocumentId` |
| `apps/api/test/transcription*.spec.ts` | Create | Unit/integration with mock STT |
| `apps/web/src/services/api.ts` | Edit | Types + cancel/retry API |
| `apps/web/src/components/KnowledgePanel.tsx` | Edit | Accept audio; status; cancel/retry |
| `.env.example` | Edit | `STT_*`, `MEDIA_ROOT`, `MAX_AUDIO_UPLOAD_BYTES` |
| `README.md` | Edit | Short audio / STT setup section |

---

## Phase P0 — MVP ship

**Status:** Implemented (P0)  
**Exit criteria (from spec §20):**

1. Upload `meeting.m4a` returns immediately with queued state (no HTTP hang for full STT).
2. With STT configured (or `STT_MOCK=true`), job completes and transcript lands in RAGFlow + auto-parse.
3. After parse `done`, chat can use meeting content.
4. Second upload while first runs is `queued`, not hard error.
5. Non-audio upload path still works.
6. `STT_BASE_URL` empty and `STT_MOCK` false → audio upload fails clearly; text upload OK.

### Task P0.1: Prisma schema + migration

- [x] Add enum `DocumentSourceType` (`file` | `audio`), default `file`
- [x] On `Document`:
  - [x] `sourceType` / `source_type`
  - [x] `mediaPath` / `media_path` (nullable)
  - [x] `mediaContentType` / `media_content_type` (nullable)
  - [x] `transcriptLanguage` / `transcript_language` (nullable)
  - [x] `durationSeconds` / `duration_seconds` (nullable float)
  - [x] Make `ragflowDocumentId` **nullable**
- [x] Add model `TranscriptionJob` per spec §5.2 (`queued|running|done|failed|cancelled`, stage, progress, attempts, locked_by, etc.)
- [x] Indexes: `(status, created_at)` on jobs; FKs with cascade on document delete
- [x] Generate migration: `npm run db:migrate` (or create SQL under `prisma/migrations/`)
- [x] `npx prisma generate` works; existing seed/smoke still applies

### Task P0.2: Audio formats + media storage

- [x] `audio-formats.ts`: allowlist `mp3,wav,m4a,mp4,flac,ogg,aac,webm,wma,mkv` + helpers `isAudioFilename` / `isAudioMime`
- [x] `media-storage.ts`:
  - [x] Resolve `MEDIA_ROOT` (default `data/media` under api cwd)
  - [x] `ensureDocDir(userId, documentId)`
  - [x] `writeSourceAudio(...)` / `sourcePath` / `transcriptPath` / `removeDocDir` (best-effort)
  - [x] Never accept client-provided absolute paths
- [x] Ensure `data/media` is gitignored if not already (check root `.gitignore`)

### Task P0.3: STT client + transcript formatter

- [x] `stt.client.ts`:
  - [x] Read `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL`, `STT_TIMEOUT_MS`
  - [x] `STT_MOCK=true` → return fixed multi-segment dummy result (no network)
  - [x] `transcribeFile(path, { language })` → multipart to `/v1/audio/transcriptions` with `response_format=verbose_json` when supported
  - [x] Normalize to `{ text, language?, duration?, segments[] }`; plain-text fallback = one segment
  - [x] Clear error if base URL missing and mock off
- [x] `transcript-format.ts`: build Markdown per spec §8 (title, metadata, `[HH:MM:SS] text` bullets)
- [x] Unit tests: formatter timestamps; mock client shape

### Task P0.4: Transcription service (enqueue / cancel / retry)

- [x] `transcription.service.ts`:
  - [x] `enqueueForDocument(doc, { language })` → create job `queued`
  - [x] `cancel(userId, kbId, docId)` — ownership via existing document/KB editable checks
  - [x] `retry(userId, kbId, docId)` — only audio + failed/cancelled + `mediaPath` exists
  - [x] Helpers to sync document `status` / `progress` / `progressMsg` / `errorMessage` from job
- [x] Wire module exports for DocumentsService

### Task P0.5: Worker pipeline

- [x] `transcription.worker.ts` implements `OnModuleInit` / `OnModuleDestroy`
- [x] Idle poll `STT_POLL_INTERVAL_MS` (default 2000)
- [x] Claim with transaction + `FOR UPDATE SKIP LOCKED` (raw query or Prisma interactive txn pattern that is safe)
- [x] Concurrency `STT_WORKER_CONCURRENCY` (default 1)
- [x] Stages: `probing` (optional no-op in P0) → `transcribing` → `writing` → `uploading` → `parsing` → `done`
- [x] Write `transcript.md` under media dir
- [x] `RagflowService.uploadDocuments` with transcript buffer; set `document.ragflowDocumentId` + name
- [x] If `STT_AUTO_PARSE=true` (default): call existing parse path; set document `running` like `DocumentsService.parse`
- [x] Failure: set job `failed`, document `fail`, `error_message`; respect `STT_JOB_MAX_ATTEMPTS` requeue
- [x] On boot: stale `running` jobs older than `STT_JOB_STALE_MS` → requeue or fail
- [x] If document deleted mid-flight: stop cleanly
- [x] Cancel flag: skip or abort between stages when job status becomes `cancelled`

### Task P0.6: Documents upload branch + API routes

- [x] Detect audio on `POST .../documents`
- [x] **Non-audio:** unchanged (RAGFlow immediate upload)
- [x] **Audio:**
  - [x] Require STT configured or mock
  - [x] Enforce `MAX_AUDIO_UPLOAD_BYTES` (default 500 MiB) + storage quota
  - [x] Prefer disk write (avoid holding huge buffers longer than needed)
  - [x] Create document with `sourceType=audio`, `ragflowDocumentId=null`, queued progress msg
  - [x] Enqueue job; return serialized doc immediately
- [x] Optional form field `language`
- [x] Routes:
  - [x] `POST .../documents/:docId/cancel-transcription`
  - [x] `POST .../documents/:docId/retry-transcription`
- [x] `serialize()` includes `sourceType`, `durationSeconds`, `transcriptLanguage`, nested `transcription` job summary
- [x] `list` / `refreshStatus`:
  - [x] Audio without `ragflowDocumentId`: refresh from job, not RAGFlow
  - [x] Audio with ragflow id + parse running: existing RAGFlow refresh
- [x] `delete`: cancel job best-effort + `removeDocDir`
- [x] Audit admin/document code paths for null `ragflowDocumentId` (no crash)

### Task P0.7: Env + README

- [x] `.env.example` document:
  - [x] `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL`, `STT_DEFAULT_LANGUAGE`
  - [x] `STT_TIMEOUT_MS`, `STT_WORKER_CONCURRENCY`, `STT_JOB_STALE_MS`, `STT_JOB_MAX_ATTEMPTS`, `STT_POLL_INTERVAL_MS`
  - [x] `STT_AUTO_PARSE`, `STT_MOCK`
  - [x] `MEDIA_ROOT`, `MAX_AUDIO_UPLOAD_BYTES`
- [x] `README.md`: short section — enable mock for dev; point `STT_BASE_URL` at local Whisper on M3 Ultra; note audio → transcript → parse

### Task P0.8: Web UI

- [x] Extend `api.ts` types + `cancelTranscription` / `retryTranscription`
- [x] Knowledge upload `accept` includes audio extensions
- [x] Show audio badge / source type
- [x] Show `progressMsg` / job status for queued & transcribing
- [x] Cancel while `queued|running` (transcription)
- [x] Retry when failed audio
- [x] Disable or hide manual **Parse** until `ragflowDocumentId` present (auto-parse covers happy path)
- [x] No new nav item (Knowledge only)

### Task P0.9: Tests + verify

- [x] Unit: `transcript-format`, audio extension detection
- [x] Unit/integration: enqueue → mock STT → document gets ragflow id (use `RAGFLOW_MOCK` + `STT_MOCK`)
- [x] Cancel queued job
- [x] Non-audio upload regression
- [x] `npm run test:api`
- [x] `npm run build` (api + web)
- [ ] Manual (optional on real machine): real Whisper URL + short mp3

### Task P0.10: Commit hygiene

- [x] Single logical commits or clean stacked commits on `feat/audio-transcription-ingest`
- [x] Do not commit media binaries or real transcripts under `data/media`
- [x] Link plan checkboxes when done (mark `[x]` in this file as tasks land)

---

## Phase P1 — Hardening

**Status:** Not started  
**Depends on:** P0 exit criteria

### Task P1.1: Smart retry

- [ ] If `transcript.md` exists and failure was post-STT, retry from upload/parse only

### Task P1.2: Duration probe

- [ ] Optional ffprobe/music-metadata at enqueue or first worker stage; set `durationSeconds` early

### Task P1.3: Upload memory

- [ ] Switch audio uploads to multer `diskStorage` into final media path (or temp then rename)
- [ ] Keep small text/pdf path as today if desired

### Task P1.4: Observability

- [ ] Structured logs with `jobId` / `documentId` / stage / attempt (no full transcript at info)
- [ ] Optional admin list of STT jobs (only if cheap to add beside existing admin tasks)

### Task P1.5: Verify

- [ ] Large-file smoke (~100MB+) without API OOM
- [ ] Stale job recovery after killing API mid-job

---

## Phase P2 — Product extras

**Status:** Not started  
**Depends on:** P0 stable in real use

### Task P2.1: Re-transcribe

- [ ] UI + API to pick language/model and re-run STT; replace transcript doc in RAGFlow (delete old RF doc or upload new + delete old)

### Task P2.2: Auto summary companion doc

- [ ] After transcript `done`, optional LLM summary via existing `OPENAI_*` as second document in same KB

### Task P2.3: Export / diarization

- [ ] SRT download; speaker labels if STT supports (out of scope until engine chosen)

### Task P2.4: Fairness

- [ ] Optional per-user concurrent job cap (global FIFO remains default)

---

## Dev notes (for implementers)

### Local mock loop (no Whisper)

```bash
# apps/api/.env
STT_MOCK=true
RAGFLOW_MOCK=true   # or real RAGFlow
```

### Real STT (M3 Ultra example)

```bash
STT_MOCK=false
STT_BASE_URL=http://127.0.0.1:8080
STT_DEFAULT_LANGUAGE=zh
STT_MODEL=  # engine-specific
STT_WORKER_CONCURRENCY=1
```

STT must accept OpenAI-style `POST /v1/audio/transcriptions` or adapt `stt.client.ts` in one place.

### Claim SQL sketch

```sql
SELECT id FROM transcription_jobs
WHERE status = 'queued'
ORDER BY created_at ASC
FOR UPDATE SKIP LOCKED
LIMIT $n;
```

Then update to `running` in the same transaction.

### Document status mapping (P0)

| Phase | `documents.status` | Typical `progressMsg` |
|-------|--------------------|------------------------|
| Queued | `unstart` | `Queued for transcription` |
| STT / write / RF upload | `running` | stage messages |
| Parse | `running` | RAGFlow / existing msgs |
| Success | `done` | |
| Fail / cancel | `fail` | error or `Cancelled` |

---

## Suggested execution order

1. P0.1 → P0.2 → P0.3 (can parallel P0.2/P0.3 after schema)  
2. P0.4 → P0.5  
3. P0.6 (wire upload)  
4. P0.7 + P0.8  
5. P0.9 verify  
6. Only then P1 / P2  

Do **not** start Meetily code ports or real-time capture work under this plan.
