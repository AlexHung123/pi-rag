import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TranscriptionJob } from '@prisma/client';
import * as os from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { MediaStorage } from './media-storage';
import { SttClient } from './stt.client';
import {
  buildTranscriptMarkdown,
  transcriptRagflowFilename,
} from './transcript-format';
import { transcriptionLogFields } from './transcription-log';
import { decodeMojibakeUtf8 } from '../common/filename';
import { needsWavTranscode } from './audio-formats';
import { transcodeToWav16kMono } from './ffmpeg-transcode';
import * as path from 'path';

@Injectable()
export class TranscriptionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TranscriptionWorker.name);
  private readonly instanceId = `${os.hostname()}:${process.pid}:${Date.now().toString(36)}`;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private active = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaStorage,
    private readonly stt: SttClient,
    private readonly ragflow: RagflowService,
  ) {}

  onModuleInit() {
    void this.recoverStaleJobs().catch((e) =>
      this.logger.warn(
        transcriptionLogFields({
          event: 'stale_recovery_error',
          error: e instanceof Error ? e.message : String(e),
        }),
      ),
    );
    const interval = Math.max(500, Number(process.env.STT_POLL_INTERVAL_MS || 2000));
    this.timer = setInterval(() => {
      void this.tick().catch((e) =>
        this.logger.error(
          transcriptionLogFields({
            event: 'tick_error',
            error: e instanceof Error ? e.message : String(e),
          }),
        ),
      );
    }, interval);
    // unref so tests / short-lived processes can exit
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(
      transcriptionLogFields({
        event: 'worker_start',
        instance: this.instanceId,
        pollMs: interval,
        concurrency: this.concurrency(),
      }),
    );
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private concurrency(): number {
    return Math.max(1, Number(process.env.STT_WORKER_CONCURRENCY || 1));
  }

  private staleMs(): number {
    return Math.max(60_000, Number(process.env.STT_JOB_STALE_MS || 7_200_000));
  }

  private autoParse(): boolean {
    const v = (process.env.STT_AUTO_PARSE || 'true').toLowerCase();
    return v !== 'false' && v !== '0';
  }

  /**
   * When false (default), stop after writing transcript.md so the user can
   * preview and click "Ingest to knowledge base" (upload to RAGFlow).
   * When true, immediately upload + optional auto-parse (legacy happy path).
   */
  private autoIngest(): boolean {
    const v = (process.env.STT_AUTO_INGEST || 'false').toLowerCase();
    return v === 'true' || v === '1';
  }

  private async recoverStaleJobs() {
    const cutoff = new Date(Date.now() - this.staleMs());
    const stale = await this.prisma.transcriptionJob.findMany({
      where: {
        status: 'running',
        OR: [{ startedAt: { lt: cutoff } }, { startedAt: null, updatedAt: { lt: cutoff } }],
      },
    });
    for (const job of stale) {
      if (job.attempts >= job.maxAttempts) {
        await this.failJob(job.id, job.documentId, 'Stale running job exceeded max attempts');
        this.logger.warn(
          transcriptionLogFields({
            event: 'stale_fail',
            jobId: job.id,
            documentId: job.documentId,
            attempt: job.attempts,
          }),
        );
      } else {
        await this.prisma.transcriptionJob.update({
          where: { id: job.id },
          data: {
            status: 'queued',
            stage: 'queued',
            progressMsg: 'Requeued after stale lock',
            lockedBy: null,
            startedAt: null,
          },
        });
        await this.prisma.document.updateMany({
          where: { id: job.documentId },
          data: {
            status: 'unstart',
            progressMsg: 'Requeued after stale lock',
            errorMessage: null,
          },
        });
        this.logger.warn(
          transcriptionLogFields({
            event: 'stale_requeue',
            jobId: job.id,
            documentId: job.documentId,
            attempt: job.attempts,
          }),
        );
      }
    }
  }

  private async tick() {
    if (this.stopped) return;
    if (!this.stt.isConfigured()) return;
    const slots = this.concurrency() - this.active;
    if (slots <= 0) return;

    const claimed = await this.claimJobs(slots);
    for (const job of claimed) {
      this.active += 1;
      void this.processJob(job)
        .catch((e) =>
          this.logger.error(
            transcriptionLogFields({
              event: 'job_unhandled',
              jobId: job.id,
              documentId: job.documentId,
              error: e instanceof Error ? e.message : String(e),
            }),
          ),
        )
        .finally(() => {
          this.active -= 1;
        });
    }
  }

  /**
   * Claim up to `limit` queued jobs with FOR UPDATE SKIP LOCKED.
   */
  private async claimJobs(limit: number): Promise<TranscriptionJob[]> {
    if (limit <= 0) return [];
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM transcription_jobs
          WHERE status = 'queued'
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        `;
        if (!rows.length) return [];

        const claimed: TranscriptionJob[] = [];
        for (const row of rows) {
          const job = await tx.transcriptionJob.update({
            where: { id: row.id },
            data: {
              status: 'running',
              stage: 'transcribing',
              progress: 0.02,
              progressMsg: 'Starting…',
              lockedBy: this.instanceId,
              startedAt: new Date(),
              attempts: { increment: 1 },
              errorMessage: null,
            },
          });
          await tx.document.updateMany({
            where: { id: job.documentId },
            data: {
              status: 'running',
              progress: 0.02,
              progressMsg: 'Starting…',
              errorMessage: null,
            },
          });
          claimed.push(job);
        }
        return claimed;
      });
    } catch (e) {
      this.logger.debug?.(
        transcriptionLogFields({
          event: 'claim_failed',
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      return [];
    }
  }

  private async isCancelled(jobId: string): Promise<boolean> {
    const j = await this.prisma.transcriptionJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    return !j || j.status === 'cancelled';
  }

  private async processJob(job: TranscriptionJob) {
    const started = Date.now();
    const baseLog = {
      jobId: job.id,
      documentId: job.documentId,
      attempt: job.attempts,
    };
    try {
      const doc = await this.prisma.document.findUnique({
        where: { id: job.documentId },
        include: { knowledgeBase: true },
      });
      if (!doc) {
        await this.prisma.transcriptionJob.update({
          where: { id: job.id },
          data: {
            status: 'cancelled',
            progressMsg: 'Document deleted',
            finishedAt: new Date(),
            lockedBy: null,
          },
        });
        this.logger.log(
          transcriptionLogFields({ ...baseLog, event: 'job_doc_missing' }),
        );
        return;
      }

      if (await this.isCancelled(job.id)) return;

      if (!doc.mediaPath) {
        throw new Error('document has no mediaPath');
      }
      const sourceAbs = this.media.absoluteFromRelative(doc.mediaPath);
      const sourceNameForType = path.basename(sourceAbs);

      // Duration only from STT response (no local ffprobe).
      let durationSeconds = doc.durationSeconds ?? null;

      if (await this.isCancelled(job.id)) return;

      // ── Smart skip: reuse existing transcript.md (post-STT failure recovery) ──
      let markdown = this.media.readTranscriptIfExists(doc.ownerUserId, doc.id);
      const skippedStt = Boolean(markdown?.trim());

      if (skippedStt) {
        this.logger.log(
          transcriptionLogFields({
            ...baseLog,
            event: 'skip_stt',
            stage: 'writing',
            reason: 'transcript_exists',
          }),
        );
        await this.setStage(job.id, doc.id, {
          stage: 'writing',
          progress: 0.7,
          progressMsg: 'Reusing existing transcript…',
        });
      } else {
        // ── Optional client-side transcode (default OFF) ──
        // Remote unified STT (e.g. 192.168.1.11:8002) converts mp4→16k mono wav
        // in-process before SenseVoice. Enable STT_CLIENT_TRANSCODE only if the
        // STT server cannot accept video containers.
        let sttInputAbs = sourceAbs;
        const clientTranscode =
          (process.env.STT_CLIENT_TRANSCODE || '').toLowerCase() === 'true' ||
          (process.env.STT_CLIENT_TRANSCODE || '').toLowerCase() === '1';
        const forceWav = (process.env.STT_FORCE_WAV || '').toLowerCase() === 'true';
        if (
          clientTranscode &&
          (needsWavTranscode(sourceNameForType) || forceWav)
        ) {
          await this.setStage(job.id, doc.id, {
            stage: 'transcoding',
            progress: 0.08,
            progressMsg: 'Converting video to WAV (16kHz mono)…',
          });
          this.logger.log(
            transcriptionLogFields({
              ...baseLog,
              event: 'stage',
              stage: 'transcoding',
              file: sourceNameForType,
              mode: 'client',
            }),
          );
          this.media.ensureDocDir(doc.ownerUserId, doc.id);
          const wavAbs = this.media.sttWavPath(doc.ownerUserId, doc.id);
          await transcodeToWav16kMono(sourceAbs, wavAbs);
          sttInputAbs = wavAbs;
        } else if (needsWavTranscode(sourceNameForType)) {
          this.logger.log(
            transcriptionLogFields({
              ...baseLog,
              event: 'skip_client_transcode',
              file: sourceNameForType,
              reason: 'remote_stt_handles_video',
            }),
          );
        }

        if (await this.isCancelled(job.id)) return;

        // ── Stage: transcribing (send original mp4/audio; remote may ffmpeg) ──
        await this.setStage(job.id, doc.id, {
          stage: 'transcribing',
          progress: 0.1,
          progressMsg: needsWavTranscode(sourceNameForType)
            ? 'Transcribing video (remote convert + STT)…'
            : 'Transcribing…',
        });
        this.logger.log(
          transcriptionLogFields({
            ...baseLog,
            event: 'stage',
            stage: 'transcribing',
            file: path.basename(sttInputAbs),
          }),
        );

        const sttResult = await this.stt.transcribeFile(sttInputAbs, {
          language: job.language || doc.transcriptLanguage,
        });

        if (await this.isCancelled(job.id)) return;

        // ── Stage: writing ──
        await this.setStage(job.id, doc.id, {
          stage: 'writing',
          progress: 0.7,
          progressMsg: 'Writing transcript…',
        });
        this.logger.log(
          transcriptionLogFields({
            ...baseLog,
            event: 'stage',
            stage: 'writing',
            segments: sttResult.segments.length,
          }),
        );

        const sourceName = decodeMojibakeUtf8(doc.name);
        const title = sourceName.replace(/\.[^.]+$/, '') || sourceName;
        markdown = buildTranscriptMarkdown({
          title,
          originalFilename: sourceName,
          language: sttResult.language || job.language,
          durationSeconds: sttResult.duration ?? durationSeconds,
          segments: sttResult.segments,
        });
        // Persist healed title if multer had stored Latin-1 mojibake
        if (sourceName !== doc.name) {
          await this.prisma.document.update({
            where: { id: doc.id },
            data: { name: title },
          });
          doc.name = title;
        }
        this.media.writeTranscript(doc.ownerUserId, doc.id, markdown);

        await this.prisma.document.update({
          where: { id: doc.id },
          data: {
            durationSeconds:
              sttResult.duration ?? durationSeconds ?? doc.durationSeconds,
            transcriptLanguage:
              sttResult.language || doc.transcriptLanguage || job.language,
          },
        });
      }

      if (!markdown?.trim()) {
        throw new Error('empty transcript');
      }

      if (await this.isCancelled(job.id)) return;

      // ── Pause for review (default): do not push to RAGFlow until user ingests ──
      if (!this.autoIngest() && !doc.ragflowDocumentId) {
        await this.prisma.transcriptionJob.update({
          where: { id: job.id },
          data: {
            status: 'done',
            stage: 'ready',
            progress: 1,
            progressMsg: 'Transcript ready for review',
            finishedAt: new Date(),
            lockedBy: null,
            sttModel: (process.env.STT_MODEL || '').trim() || null,
          },
        });
        await this.prisma.document.update({
          where: { id: doc.id },
          data: {
            status: 'unstart',
            progress: 1,
            progressMsg: 'Transcript ready — review, then ingest to knowledge base',
            errorMessage: null,
          },
        });
        this.logger.log(
          transcriptionLogFields({
            ...baseLog,
            event: 'job_ready_for_review',
            stage: 'ready',
            skipStt: skippedStt,
            ms: Date.now() - started,
          }),
        );
        return;
      }

      // If already in RAGFlow with id, only re-trigger parse if needed
      let rfDocId = doc.ragflowDocumentId;

      if (!rfDocId) {
        // ── Stage: uploading ──
        await this.setStage(job.id, doc.id, {
          stage: 'uploading',
          progress: 0.8,
          progressMsg: 'Uploading transcript…',
        });
        this.logger.log(
          transcriptionLogFields({
            ...baseLog,
            event: 'stage',
            stage: 'uploading',
            skipStt: skippedStt,
          }),
        );

        const rfName = transcriptRagflowFilename(decodeMojibakeUtf8(doc.name));
        const buffer = Buffer.from(markdown, 'utf8');
        const uploaded = await this.ragflow.uploadDocuments(
          doc.knowledgeBase.ragflowDatasetId,
          [
            {
              filename: rfName,
              buffer,
              mimetype: 'text/markdown',
            },
          ],
        );
        const rfDoc = uploaded[0];
        if (!rfDoc?.id) throw new Error('RAGFlow upload failed for transcript');
        rfDocId = rfDoc.id;

        await this.prisma.document.update({
          where: { id: doc.id },
          data: {
            ragflowDocumentId: rfDocId,
            progress: 0.85,
            progressMsg: 'Transcript uploaded',
          },
        });
      } else {
        this.logger.log(
          transcriptionLogFields({
            ...baseLog,
            event: 'skip_upload',
            stage: 'parsing',
            reason: 'ragflow_id_present',
          }),
        );
      }

      if (await this.isCancelled(job.id)) return;

      // ── Stage: parsing ──
      if (this.autoParse()) {
        await this.setStage(job.id, doc.id, {
          stage: 'parsing',
          progress: 0.9,
          progressMsg: 'Parse started',
        });
        this.logger.log(
          transcriptionLogFields({
            ...baseLog,
            event: 'stage',
            stage: 'parsing',
          }),
        );
        await this.ragflow.parseDocuments(doc.knowledgeBase.ragflowDatasetId, [
          rfDocId,
        ]);
        await this.prisma.document.update({
          where: { id: doc.id },
          data: {
            status: 'running',
            progress: 0.05,
            progressMsg: 'Parse started',
            errorMessage: null,
          },
        });
      } else {
        await this.prisma.document.update({
          where: { id: doc.id },
          data: {
            status: 'unstart',
            progress: 0,
            progressMsg: 'Transcript ready — parse to index',
            errorMessage: null,
          },
        });
      }

      await this.prisma.transcriptionJob.update({
        where: { id: job.id },
        data: {
          status: 'done',
          stage: 'done',
          progress: 1,
          progressMsg: this.autoParse()
            ? 'Transcription done; parse running'
            : 'Transcription done',
          finishedAt: new Date(),
          lockedBy: null,
          sttModel: (process.env.STT_MODEL || '').trim() || null,
        },
      });

      this.logger.log(
        transcriptionLogFields({
          ...baseLog,
          event: 'job_done',
          stage: 'done',
          skipStt: skippedStt,
          ms: Date.now() - started,
        }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(
        transcriptionLogFields({
          ...baseLog,
          event: 'job_failed',
          error: msg.slice(0, 300),
          ms: Date.now() - started,
        }),
      );
      await this.handleFailure(job, msg);
    }
  }

  private async handleFailure(job: TranscriptionJob, message: string) {
    const fresh = await this.prisma.transcriptionJob.findUnique({
      where: { id: job.id },
    });
    if (!fresh || fresh.status === 'cancelled') return;

    if (fresh.attempts < fresh.maxAttempts) {
      await this.prisma.transcriptionJob.update({
        where: { id: job.id },
        data: {
          status: 'queued',
          stage: 'queued',
          progress: 0,
          progressMsg: `Retry queued (${fresh.attempts}/${fresh.maxAttempts}): ${message.slice(0, 200)}`,
          errorMessage: message.slice(0, 2000),
          lockedBy: null,
          startedAt: null,
        },
      });
      await this.prisma.document.updateMany({
        where: { id: job.documentId },
        data: {
          status: 'unstart',
          progress: 0,
          progressMsg: `Transcription retry queued: ${message.slice(0, 120)}`,
          errorMessage: message.slice(0, 2000),
        },
      });
      this.logger.warn(
        transcriptionLogFields({
          jobId: job.id,
          documentId: job.documentId,
          event: 'job_requeue',
          attempt: fresh.attempts,
          maxAttempts: fresh.maxAttempts,
        }),
      );
      return;
    }

    await this.failJob(job.id, job.documentId, message);
  }

  private async failJob(jobId: string, documentId: string, message: string) {
    await this.prisma.transcriptionJob.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        progressMsg: 'Failed',
        errorMessage: message.slice(0, 2000),
        finishedAt: new Date(),
        lockedBy: null,
      },
    });
    await this.prisma.document.updateMany({
      where: { id: documentId },
      data: {
        status: 'fail',
        progressMsg: 'Transcription failed',
        errorMessage: message.slice(0, 2000),
      },
    });
  }

  private async setStage(
    jobId: string,
    documentId: string,
    data: { stage: string; progress: number; progressMsg: string },
  ) {
    await this.prisma.transcriptionJob.update({
      where: { id: jobId },
      data: {
        stage: data.stage,
        progress: data.progress,
        progressMsg: data.progressMsg,
      },
    });
    await this.prisma.document.updateMany({
      where: { id: documentId },
      data: {
        status: 'running',
        progress: data.progress,
        progressMsg: data.progressMsg,
        errorMessage: null,
      },
    });
  }
}
