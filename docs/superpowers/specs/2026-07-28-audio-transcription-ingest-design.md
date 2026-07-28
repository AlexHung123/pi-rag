# Audio Upload → Transcribe → Ingest — Design Spec

**Date:** 2026-07-28  
**Status:** Approved for planning / implementation  
**Product:** CSB Knowledge Base Portal (`pi-rag`)  
**Related:** [base design](./2026-07-23-pi-rag-design.md), [KB visibility](./2026-07-27-kb-visibility-sharing-design.md)  
**Inspiration:** Meetily Import Audio pipeline (product flow only — not runtime reuse)

## 1. Problem & Goals

Users want to put **meeting recordings and other audio** into a knowledge base and later **chat over that content** via the existing RAG agent.

Today the portal accepts documents and hands them to RAGFlow for parse/chunk. Audio is not a first-class source: RAGFlow is a document engine, not a speech-to-text stack.

### Goals

1. Upload common audio formats into an editable knowledge base.
2. **Asynchronously** transcribe on a **local STT service** (target host: Apple M3 Ultra).
3. Materialize a **timestamped transcript document** and ingest it through the **existing RAGFlow upload + parse** path.
4. Maintain a **lightweight job queue** (DB-backed, limited concurrency) so multiple uploads queue instead of failing hard.
5. Keep **browser → NestJS only**; STT never exposed to the browser.
6. Preserve multi-user isolation (KB edit rights, storage quota, 404 on cross-user access).

### Non-goals (MVP)

- Real-time microphone / system-audio capture (desktop Meetily territory).
- Speaker diarization.
- Polished meeting-minutes editor, re-transcribe UI, SRT export (later).
- In-browser Whisper (WASM) or cloud STT as the default (optional later via same client interface).
- Redis / BullMQ / multi-node workers (single-machine queue is enough).
- Copying Meetily’s Tauri/Rust audio pipeline into this repo.

## 2. Product decisions (locked)

| Decision | Choice |
|----------|--------|
| UX surface | Extend **Knowledge** document upload; audio is a document **source type**, not a separate “Meetings” app |
| Final RAG artifact | Timestamped **Markdown transcript** ingested as a normal RAGFlow document |
| Intermediate media | Store original audio on API local disk (for retry / future re-transcribe); not uploaded to RAGFlow |
| STT runtime | **External process** on the same machine (or LAN), OpenAI-compatible HTTP API |
| Queue | **Postgres job rows** + in-process worker (Nest), concurrency default **1** |
| Progress UX | Reuse `Document.status` / `progress` / `progressMsg`; list polling already exists |
| Auto-parse | After successful transcript ingest, **automatically start parse** (same as user clicking Parse) |
| Language | Optional per-upload; default `STT_DEFAULT_LANGUAGE` (e.g. `zh`) |
| Meetily reuse | Conceptual only: stages, validation, segments-with-timestamps, cancel |

## 3. High-level flow

```text
Browser (Knowledge)
  │  multipart audio upload
  ▼
NestJS Documents API
  │  validate mime/ext/size/quota
  │  write audio to local media store
  │  create Document (sourceType=audio, status=queued)
  │  create TranscriptionJob (queued)
  │  return document JSON immediately
  ▼
TranscriptionWorker (in Nest, single consumer)
  │  claim next job (FOR UPDATE SKIP LOCKED)
  │  call STT service with file path / stream
  │  write transcript.md (timestamped segments)
  │  RAGFlow uploadDocuments(transcript.md)
  │  set ragflowDocumentId, status → unstart then parse → running
  ▼
RAGFlow parse/chunk  (existing refreshStatus path)
  ▼
Chat agent retrieve_chunks  (unchanged)
```

```text
┌─────────────┐     upload      ┌──────────────────────────┐
│  apps/web   │ ───────────────►│  apps/api  Documents     │
│  Knowledge  │ ◄── list poll ──│  + TranscriptionWorker   │
└─────────────┘                 └────────────┬─────────────┘
                                             │
                    local media + jobs (PG)  │
                                             ▼
                                    ┌─────────────────┐
                                    │ STT service     │
                                    │ (Whisper/MLX)   │
                                    │ :local HTTP     │
                                    └─────────────────┘
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │ RAGFlow         │
                                    │ (text doc only) │
                                    └─────────────────┘
```

## 4. Queue design

### 4.1 Why a queue (vs Meetily)

Meetily Import uses a process-global `IMPORT_IN_PROGRESS` mutex: a second import **errors** while one is running. That is fine for a single-user desktop app.

pi-rag is multi-user web: concurrent uploads should **enqueue**. Restart should not lose “accepted but not finished” work if the audio file is still on disk.

### 4.2 Model

New table `transcription_jobs` (see §5). Each audio document has **at most one active** job (`queued` | `running`). Terminal states: `done` | `failed` | `cancelled`.

### 4.3 Worker

- Runs **inside NestJS** as a long-lived provider (`OnModuleInit` + interval or `setImmediate` loop).
- Concurrency: `STT_WORKER_CONCURRENCY` (default **1**) — protects M3 Ultra memory when using large Whisper models.
- Claim algorithm:
  1. Transaction: `SELECT … FROM transcription_jobs WHERE status = 'queued' ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT N`
  2. Set `status = 'running'`, `started_at = now()`, `locked_by = instance_id`
  3. Process outside transaction
  4. On success → `done`; on failure → `failed` + `error_message`; always update parent `Document`
- Crash recovery on boot:
  - Jobs stuck in `running` longer than `STT_JOB_STALE_MS` (default 2h) → reset to `queued` (or `failed` after `STT_JOB_MAX_ATTEMPTS`)
  - Increment `attempts` on each claim

### 4.4 What is intentionally not in MVP

- Priority queue / fair scheduling across users (FIFO global is OK)
- Separate worker process (can extract later without changing job schema)
- Redis / BullMQ

### 4.5 Interaction with RAGFlow parse queue

Transcription queue **ends** when the Markdown file is uploaded to RAGFlow and parse is triggered. From then on, existing `Document.status` + `refreshStatus` track RAGFlow parse. Admin “Tasks” tab (if present) continues to reflect RAGFlow parse only unless we later surface STT jobs there.

## 5. Data model

### 5.1 Extend `documents`

| Column | Type | Notes |
|--------|------|-------|
| `source_type` | enum `file` \| `audio` | default `file` for existing rows |
| `media_path` | text nullable | relative path under media root; audio only |
| `media_content_type` | text nullable | e.g. `audio/mpeg` |
| `transcript_language` | text nullable | BCP-47 / Whisper code, e.g. `zh` |
| `duration_seconds` | float nullable | filled after probe or STT |

Existing fields reuse:

| Field | Audio pipeline usage |
|-------|----------------------|
| `status` | see §6 state machine |
| `progress` | 0–1 float (already used for parse) |
| `progress_msg` | human stage message |
| `error_message` | STT or ingest failure |
| `ragflow_document_id` | empty/placeholder until transcript uploaded |
| `size_bytes` | **original audio** size (quota); transcript size not double-counted for MVP |
| `name` | user-facing title; default from filename without ext |

**RAGFlow id timing:** Audio docs are created **before** RAGFlow knows about them. Options:

| Option | Choice for MVP |
|--------|----------------|
| A. Nullable `ragflow_document_id` until transcript ready | **Chosen** |
| B. Upload a stub `.txt` first then replace | Avoid — messy in RAGFlow |
| C. Separate table without Document until done | Avoid — breaks list/UX |

Migration: make `ragflow_document_id` **nullable**. Unique constraints: none on that column today beyond index usage — confirm no `@unique` (current schema: non-unique). Filter any admin/RAGFlow sync that assumes always present.

### 5.2 `transcription_jobs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `document_id` | uuid FK → documents, unique among non-terminal optional | FK cascade on document delete |
| `knowledge_base_id` | uuid | denormalized for admin listing |
| `owner_user_id` | uuid | denormalized for isolation |
| `status` | enum `queued` `running` `done` `failed` `cancelled` | |
| `stage` | text | `queued` `probing` `transcribing` `writing` `uploading` `parsing` `done` |
| `progress` | float 0–1 | job-level |
| `progress_msg` | text nullable | |
| `language` | text nullable | requested language |
| `stt_model` | text nullable | resolved model name |
| `attempts` | int default 0 | |
| `max_attempts` | int default 3 | |
| `locked_by` | text nullable | worker instance id |
| `error_message` | text nullable | |
| `started_at` / `finished_at` | timestamptz nullable | |
| `created_at` / `updated_at` | timestamptz | |

Indexes:

- `(status, created_at)` for claim
- `(document_id)`
- `(owner_user_id, created_at)`

### 5.3 Local media layout

```text
{MEDIA_ROOT}/
  {userId}/
    {documentId}/
      source.{ext}           # original audio
      transcript.md          # generated
      stt-raw.json           # optional raw STT response for debug
```

- `MEDIA_ROOT` default: `apps/api/data/media`
- Delete document → delete directory (best-effort) + cancel job if queued/running
- Backups / disk: operator concern; document in ops notes

## 6. Document status state machine

Extend semantic meaning of existing `DocumentStatus` without adding many DB enum values if possible.

**Preferred MVP:** keep enum `unstart | running | done | fail` and encode audio pre-RAG stages in `progress_msg` + job table; map as:

| Phase | `documents.status` | `progress` (guide) | `progress_msg` example |
|-------|--------------------|--------------------|------------------------|
| Accepted, waiting worker | `unstart` | 0 | `Queued for transcription` |
| STT running | `running` | 0.05–0.70 | `Transcribing…` / stage detail |
| Uploading transcript to RAGFlow | `running` | 0.75–0.85 | `Uploading transcript…` |
| Parse started | `running` | 0.05–1.0 via RAGFlow | existing parse messages |
| All good | `done` | 1 | |
| STT/ingest failed | `fail` | — | + `error_message` |
| Cancelled before STT finish | `fail` or `unstart` | 0 | `Cancelled` — **use `fail` + msg** for clarity |

**Alternative (cleaner, slightly more migration):** add statuses `queued` | `transcribing`. Implement only if product wants explicit filters; not required for MVP if UI keys off `sourceType` + `progressMsg`.

**List refresh:** Today `list()` refreshes RAGFlow for `running|unstart`. Extend:

- If `source_type = audio` and job not terminal → refresh from **job row** (not RAGFlow).
- If `ragflow_document_id` set and status `running` → existing RAGFlow refresh.

## 7. STT service contract

### 7.1 Deployment

Recommended on M3 Ultra:

| Engine | Notes |
|--------|-------|
| **mlx-whisper** (preferred if already MLX stack) | Aligns with local MLX LLM |
| whisper.cpp HTTP server | Mature Metal path |
| faster-whisper | OK; less optimal on Apple GPU |

Nest only depends on HTTP + env, not a specific binary.

### 7.2 API shape (OpenAI-compatible preferred)

```http
POST {STT_BASE_URL}/v1/audio/transcriptions
Content-Type: multipart/form-data

file: <audio>
model: <optional>
language: zh
response_format: verbose_json   # want segments with timestamps
```

Response (normalized by client):

```ts
type SttResult = {
  text: string;
  language?: string;
  duration?: number;
  segments: Array<{
    start: number; // seconds
    end: number;
    text: string;
  }>;
};
```

If the engine only returns plain text, client synthesizes a single segment `[{ start: 0, end: duration ?? 0, text }]`.

### 7.3 Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `STT_BASE_URL` | empty | If empty, audio upload returns **503/400** “STT not configured” |
| `STT_API_KEY` | empty | Optional bearer |
| `STT_MODEL` | engine default | Model name passed to STT |
| `STT_DEFAULT_LANGUAGE` | `zh` | Default language |
| `STT_TIMEOUT_MS` | `3600000` | Per-job HTTP timeout (long meetings) |
| `STT_WORKER_CONCURRENCY` | `1` | Parallel jobs |
| `STT_JOB_STALE_MS` | `7200000` | Running → requeue threshold |
| `STT_JOB_MAX_ATTEMPTS` | `3` | Then fail |
| `STT_POLL_INTERVAL_MS` | `2000` | Worker idle poll |
| `MEDIA_ROOT` | `data/media` | Under api cwd |
| `MAX_AUDIO_UPLOAD_BYTES` | `524288000` (500 MiB) | Audio-specific cap; falls back to `MAX_UPLOAD_BYTES` if unset |
| `STT_AUTO_PARSE` | `true` | After upload transcript, call parse |

## 8. Transcript artifact format

Generate UTF-8 Markdown for RAG quality and human preview:

```markdown
# {title}

- **Source:** {original_filename}
- **Language:** {lang}
- **Duration:** {mm:ss}
- **Transcribed at:** {ISO-8601}

## Transcript

- [00:01:12] 我们下周一发布登录改版
- [00:03:40] 后端接口由张三负责
…
```

Rules:

- One bullet per segment; merge tiny adjacent segments only if needed later (not MVP).
- Timestamps `HH:MM:SS` (or `MM:SS` if &lt; 1h).
- Filename uploaded to RAGFlow: `{safeBaseName}.transcript.md` (avoid colliding with user’s other docs when possible).

Document `name` in portal: original audio base name (e.g. `周会-0728`), not the `.transcript.md` unless user renames later.

## 9. API

All under existing auth + CSRF. KB must be **editable** for mutations.

### 9.1 Upload (extend existing)

```http
POST /api/knowledge-bases/:kbId/documents
Content-Type: multipart/form-data
file: <blob>
language: zh          # optional field
```

Behavior:

1. Detect audio by extension allowlist **and/or** mime (`audio/*`, plus `video/mp4` if we allow mp4 containers for audio-only meetings — **allow** same set as Meetily-inspired list).
2. **Non-audio:** existing path unchanged (buffer → RAGFlow).
3. **Audio:**
   - Enforce `MAX_AUDIO_UPLOAD_BYTES`
   - Quota check on audio bytes
   - Persist file under `MEDIA_ROOT`
   - Create `Document` (`source_type=audio`, `ragflow_document_id=null`, `status=unstart`, msg queued)
   - Create `TranscriptionJob` `queued`
   - Return serialized document (**do not** wait for STT)

### 9.2 Cancel

```http
POST /api/knowledge-bases/:kbId/documents/:docId/cancel-transcription
```

- If job `queued`: mark `cancelled`; document `fail` + msg Cancelled (or delete — **prefer leave doc**, user can delete).
- If `running`: set cancel flag; worker aborts between stages (best-effort; HTTP call may finish).
- If already in RAGFlow parse: use existing stop-parse.

### 9.3 Retry

```http
POST /api/knowledge-bases/:kbId/documents/:docId/retry-transcription
```

- Allowed when `source_type=audio` and status `fail` (or job `failed`/`cancelled`) and `media_path` still exists.
- New job row or reset same row to `queued` with `attempts` preserved/capped.

### 9.4 List / get

Extend serialized document:

```ts
{
  // existing fields...
  sourceType: 'file' | 'audio';
  durationSeconds: number | null;
  transcriptLanguage: string | null;
  transcription?: {
    jobId: string;
    status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
    stage: string;
    progress: number;
    progressMsg: string | null;
    errorMessage: string | null;
  } | null;
}
```

### 9.5 Allowed extensions (MVP)

```text
mp3, wav, m4a, mp4, flac, ogg, aac, webm, wma, mkv
```

(Align with Meetily’s import list; server is source of truth.)

## 10. Modules & code map (target)

| Path | Role |
|------|------|
| `apps/api/prisma/schema.prisma` | `sourceType`, nullable `ragflowDocumentId`, `TranscriptionJob` |
| `apps/api/src/transcription/transcription.module.ts` | module |
| `apps/api/src/transcription/stt.client.ts` | HTTP client + normalize segments |
| `apps/api/src/transcription/transcript-format.ts` | Markdown builder |
| `apps/api/src/transcription/transcription.worker.ts` | claim loop + pipeline |
| `apps/api/src/transcription/transcription.service.ts` | enqueue / cancel / retry |
| `apps/api/src/transcription/media-storage.ts` | paths, write/delete |
| `apps/api/src/documents/documents.service.ts` | branch upload; serialize extras; delete hooks |
| `apps/api/src/documents/documents.controller.ts` | cancel/retry routes; optional language field |
| `apps/web/.../KnowledgePanel.tsx` | accept audio; show queued/transcribing; retry |
| `.env.example` | STT_* + MEDIA_ROOT + MAX_AUDIO_* |

## 11. Frontend UX

1. File picker `accept` includes audio extensions (+ drag-drop already present).
2. Row badges:
   - Audio icon when `sourceType === 'audio'`
   - Status text from `progressMsg` / job status (“排队转写中”, “转写中 42%”, “解析中”, “完成”)
3. Actions:
   - While job `queued|running`: **Cancel transcription**
   - While `fail` and audio: **Retry transcription**
   - **Parse** button: hidden or disabled until `ragflowDocumentId` present (auto-parse handles happy path)
4. Preview: once transcript ingested, existing preview path for `.md` / plain text; if preview only works via RAGFlow file API, ensure upload uses a previewable type.
5. Storage meter: counts original audio bytes (existing quota).

No separate “Meetings” nav item in MVP.

## 12. Security & isolation

- Same as documents: mutations require KB **editor** (or owner); reads require readable KB.
- Jobs always filtered by ownership via document/KB checks; never trust client job ids without KB scope.
- STT URL and API key **server-only**.
- Media files served only via authenticated document download endpoint if we add one; **do not** put `MEDIA_ROOT` under static public.
- Path traversal: documentId/userId from server UUIDs only; never join user-provided paths.

## 13. Failure modes

| Failure | Behavior |
|---------|----------|
| STT not configured | Reject audio upload with clear error |
| STT timeout / 5xx | job attempt++; requeue or fail at max |
| Corrupt audio | fail job; message from STT/ffmpeg |
| RAGFlow upload fails after STT | keep transcript on disk; fail job; **retry** reuses transcript if present (optimization: skip STT if `transcript.md` exists) |
| Parse fails | document follows existing parse fail handling; transcript already in RAGFlow |
| User deletes doc mid-job | cancel flag + delete media; worker no-ops if doc missing |
| Disk full | fail job; surface error_message |

**Retry optimization (P1):** if `transcript.md` exists and only ingest failed, retry from upload stage.

## 14. Observability

- Structured logs: `documentId`, `jobId`, `stage`, `attempt`, duration ms.
- Optional: admin later lists `transcription_jobs` (not required for MVP; Knowledge list is enough).
- Do not log full transcript text at info level (privacy / size).

## 15. Testing

| Layer | Cases |
|-------|-------|
| Unit | Markdown formatter; extension detection; status mapping |
| Unit | Job claim with concurrent workers (SKIP LOCKED) — can use Prisma + test DB |
| Integration | Upload audio with **mock STT** HTTP server → job done → ragflow mock received `.md` |
| Integration | Cancel queued job |
| Integration | Non-audio upload regression |
| Manual | Real Whisper on M3 Ultra, 30–60 min meeting file |

`RAGFLOW_MOCK=true` should still accept transcript upload path.

## 16. Implementation phases

### P0 — MVP (target first ship)

1. Prisma migration (nullable ragflow id, source fields, jobs table).
2. Media storage + audio upload branch.
3. STT client + mock mode (`STT_MOCK=true` returns dummy segments for dev without Whisper).
4. Worker pipeline: transcribe → md → RAGFlow → auto-parse.
5. Serialize job info; web accept + status strings + cancel/retry.
6. `.env.example` + README short “Audio transcription” section.

### P1 — Hardening

- Skip STT on retry when transcript exists.
- Probe duration (ffprobe) at enqueue.
- Larger file streaming to STT (avoid loading entire file in Nest memory twice — today multer memoryStorage; consider diskStorage for audio).
- Admin visibility of STT jobs (optional tab column).

### P2 — Product extras

- Re-transcribe with different language/model.
- Optional LLM summary doc auto-created beside transcript (uses existing `OPENAI_*`).
- Diarization / SRT export.
- Fair per-user concurrency limits.

## 17. Multer / memory note

Current upload uses `memoryStorage()` and `MAX_UPLOAD_BYTES` default 50 MiB. Audio MVP should:

1. Raise audio cap via `MAX_AUDIO_UPLOAD_BYTES`.
2. Prefer **diskStorage** for audio uploads directly into `MEDIA_ROOT/.../source.ext` to avoid double RAM (request buffer + STT read). Non-audio may keep memory path for small docs.

## 18. Relationship to Meetily

| Borrow | Do not borrow |
|--------|----------------|
| Async stages + progress messaging | Tauri commands / events |
| Extension allowlist spirit | In-process whisper-rs / Parakeet |
| Segment + timestamp product shape | Meeting entity, live capture, VAD pipeline |
| Cancel + single-flight idea | Global “one import only” rejection — we **queue** instead |

Meetily remains a reference implementation checklist, not a dependency.

## 19. Open questions (resolved defaults)

| Question | Default |
|----------|---------|
| Store audio long-term? | Yes, under MEDIA_ROOT until doc deleted |
| Upload audio to RAGFlow? | No |
| Multi-file batch audio? | One file per request (existing API); user can multi-select later as multiple requests |
| Default language | `zh` |
| Concurrency | 1 |
| Auto-parse | yes |

## 20. Success criteria

1. User uploads `meeting.m4a` into a KB and sees “Queued for transcription” without request timeout.
2. On a machine with STT configured, job completes and transcript appears as a parseable document.
3. After parse `done`, chat over that KB can answer questions grounded in the meeting content.
4. Second upload while first is running becomes `queued`, not an error.
5. Non-audio document path and tests remain green.
6. With `STT_BASE_URL` unset, audio upload fails loudly; text upload still works.

---

**Implementation plan (checklist):** [`../plans/2026-07-28-audio-transcription-ingest.md`](../plans/2026-07-28-audio-transcription-ingest.md)
