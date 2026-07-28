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
      this.logger.warn(`stale recovery: ${e instanceof Error ? e.message : e}`),
    );
    const interval = Math.max(500, Number(process.env.STT_POLL_INTERVAL_MS || 2000));
    this.timer = setInterval(() => {
      void this.tick().catch((e) =>
        this.logger.error(`tick error: ${e instanceof Error ? e.message : e}`),
      );
    }, interval);
    // unref so tests / short-lived processes can exit
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(
      `Transcription worker started (instance=${this.instanceId}, poll=${interval}ms, concurrency=${this.concurrency()})`,
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
        this.logger.warn(`Requeued stale job ${job.id}`);
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
            `job ${job.id} unhandled: ${e instanceof Error ? e.message : e}`,
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
              progress: 0.05,
              progressMsg: 'Transcribing…',
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
              progress: 0.05,
              progressMsg: 'Transcribing…',
              errorMessage: null,
            },
          });
          claimed.push(job);
        }
        return claimed;
      });
    } catch (e) {
      // e.g. table not migrated yet in tests without DB
      this.logger.debug?.(
        `claimJobs failed: ${e instanceof Error ? e.message : e}`,
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
    const logCtx = `job=${job.id} doc=${job.documentId}`;
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
        return;
      }

      if (await this.isCancelled(job.id)) return;

      if (!doc.mediaPath) {
        throw new Error('document has no mediaPath');
      }
      const audioAbs = this.media.absoluteFromRelative(doc.mediaPath);

      // ── Stage: transcribing ──
      await this.setStage(job.id, doc.id, {
        stage: 'transcribing',
        progress: 0.1,
        progressMsg: 'Transcribing…',
      });

      const sttResult = await this.stt.transcribeFile(audioAbs, {
        language: job.language || doc.transcriptLanguage,
      });

      if (await this.isCancelled(job.id)) return;

      // ── Stage: writing ──
      await this.setStage(job.id, doc.id, {
        stage: 'writing',
        progress: 0.7,
        progressMsg: 'Writing transcript…',
      });

      const title = doc.name.replace(/\.[^.]+$/, '') || doc.name;
      const markdown = buildTranscriptMarkdown({
        title,
        originalFilename: doc.name,
        language: sttResult.language || job.language,
        durationSeconds: sttResult.duration,
        segments: sttResult.segments,
      });
      this.media.writeTranscript(doc.ownerUserId, doc.id, markdown);

      await this.prisma.document.update({
        where: { id: doc.id },
        data: {
          durationSeconds: sttResult.duration ?? doc.durationSeconds,
          transcriptLanguage: sttResult.language || doc.transcriptLanguage || job.language,
        },
      });

      if (await this.isCancelled(job.id)) return;

      // ── Stage: uploading ──
      await this.setStage(job.id, doc.id, {
        stage: 'uploading',
        progress: 0.8,
        progressMsg: 'Uploading transcript…',
      });

      const rfName = transcriptRagflowFilename(doc.name);
      const buffer = Buffer.from(markdown, 'utf8');
      const uploaded = await this.ragflow.uploadDocuments(doc.knowledgeBase.ragflowDatasetId, [
        {
          filename: rfName,
          buffer,
          mimetype: 'text/markdown',
        },
      ]);
      const rfDoc = uploaded[0];
      if (!rfDoc?.id) throw new Error('RAGFlow upload failed for transcript');

      await this.prisma.document.update({
        where: { id: doc.id },
        data: {
          ragflowDocumentId: rfDoc.id,
          // Keep portal name as original audio base title
          progress: 0.85,
          progressMsg: 'Transcript uploaded',
        },
      });

      if (await this.isCancelled(job.id)) return;

      // ── Stage: parsing ──
      if (this.autoParse()) {
        await this.setStage(job.id, doc.id, {
          stage: 'parsing',
          progress: 0.9,
          progressMsg: 'Parse started',
        });
        await this.ragflow.parseDocuments(doc.knowledgeBase.ragflowDatasetId, [rfDoc.id]);
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
          progressMsg: this.autoParse() ? 'Transcription done; parse running' : 'Transcription done',
          finishedAt: new Date(),
          lockedBy: null,
          sttModel: (process.env.STT_MODEL || '').trim() || null,
        },
      });

      this.logger.log(`${logCtx} done`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`${logCtx} failed: ${msg}`);
      await this.handleFailure(job, msg);
    }
  }

  private async handleFailure(job: TranscriptionJob, message: string) {
    const fresh = await this.prisma.transcriptionJob.findUnique({ where: { id: job.id } });
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
