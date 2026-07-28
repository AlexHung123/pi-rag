import { Injectable, Logger } from '@nestjs/common';
import {
  Document,
  TranscriptionJob,
  TranscriptionJobStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { badRequest, notFound } from '../common/errors';
import { MediaStorage } from './media-storage';
import { SttClient } from './stt.client';

export type TranscriptionSummary = {
  jobId: string;
  status: TranscriptionJobStatus;
  stage: string;
  progress: number;
  progressMsg: string | null;
  errorMessage: string | null;
};

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    private readonly media: MediaStorage,
    private readonly stt: SttClient,
  ) {}

  maxAttempts(): number {
    return Math.max(1, Number(process.env.STT_JOB_MAX_ATTEMPTS || 3));
  }

  async enqueueForDocument(
    doc: Document,
    opts?: { language?: string | null },
  ): Promise<TranscriptionJob> {
    this.stt.assertConfigured();
    const language =
      (opts?.language ||
        doc.transcriptLanguage ||
        process.env.STT_DEFAULT_LANGUAGE ||
        'zh')?.trim() || null;

    const job = await this.prisma.transcriptionJob.create({
      data: {
        documentId: doc.id,
        knowledgeBaseId: doc.knowledgeBaseId,
        ownerUserId: doc.ownerUserId,
        status: 'queued',
        stage: 'queued',
        progress: 0,
        progressMsg: 'Queued for transcription',
        language,
        maxAttempts: this.maxAttempts(),
      },
    });

    await this.prisma.document.update({
      where: { id: doc.id },
      data: {
        status: 'unstart',
        progress: 0,
        progressMsg: 'Queued for transcription',
        errorMessage: null,
        transcriptLanguage: language,
      },
    });

    return job;
  }

  async cancel(userId: string, kbId: string, docId: string) {
    await this.knowledge.getEditable(userId, kbId);
    const doc = await this.prisma.document.findFirst({
      where: { id: docId, knowledgeBaseId: kbId },
    });
    if (!doc) throw notFound('document not found');
    if (doc.sourceType !== 'audio') {
      throw badRequest('document is not an audio source');
    }

    const job = await this.latestJob(doc.id);
    if (!job) throw badRequest('no transcription job found');
    if (job.status === 'done') {
      throw badRequest('transcription already completed');
    }
    if (job.status === 'cancelled') {
      return { ok: true as const, job: this.summarize(job) };
    }
    if (job.status === 'failed') {
      throw badRequest('job already failed; use retry instead');
    }

    // queued | running → cancel
    const updated = await this.prisma.transcriptionJob.update({
      where: { id: job.id },
      data: {
        status: 'cancelled',
        progressMsg: 'Cancelled',
        errorMessage: 'Cancelled by user',
        finishedAt: new Date(),
        lockedBy: null,
      },
    });

    await this.prisma.document.update({
      where: { id: doc.id },
      data: {
        status: 'fail',
        progress: 0,
        progressMsg: 'Cancelled',
        errorMessage: 'Cancelled by user',
      },
    });

    return { ok: true as const, job: this.summarize(updated) };
  }

  async retry(userId: string, kbId: string, docId: string) {
    await this.knowledge.getEditable(userId, kbId);
    const doc = await this.prisma.document.findFirst({
      where: { id: docId, knowledgeBaseId: kbId },
    });
    if (!doc) throw notFound('document not found');
    if (doc.sourceType !== 'audio') {
      throw badRequest('document is not an audio source');
    }
    if (!doc.mediaPath || !this.media.existsRelative(doc.mediaPath)) {
      throw badRequest('original audio is missing; re-upload the file');
    }

    this.stt.assertConfigured();

    const prev = await this.latestJob(doc.id);
    if (prev && (prev.status === 'queued' || prev.status === 'running')) {
      throw badRequest('a transcription job is already active');
    }
    if (prev && prev.status !== 'failed' && prev.status !== 'cancelled') {
      if (prev.status === 'done' && doc.status !== 'fail') {
        throw badRequest('transcription already succeeded');
      }
    }

    const job = await this.prisma.transcriptionJob.create({
      data: {
        documentId: doc.id,
        knowledgeBaseId: doc.knowledgeBaseId,
        ownerUserId: doc.ownerUserId,
        status: 'queued',
        stage: 'queued',
        progress: 0,
        progressMsg: 'Queued for transcription (retry)',
        language: doc.transcriptLanguage,
        maxAttempts: this.maxAttempts(),
        attempts: 0,
      },
    });

    await this.prisma.document.update({
      where: { id: doc.id },
      data: {
        status: 'unstart',
        progress: 0,
        progressMsg: 'Queued for transcription (retry)',
        errorMessage: null,
      },
    });

    return job;
  }

  async latestJob(documentId: string): Promise<TranscriptionJob | null> {
    return this.prisma.transcriptionJob.findFirst({
      where: { documentId },
      orderBy: { createdAt: 'desc' },
    });
  }

  summarize(job: TranscriptionJob | null | undefined): TranscriptionSummary | null {
    if (!job) return null;
    return {
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      progressMsg: job.progressMsg,
      errorMessage: job.errorMessage,
    };
  }

  /** Sync document progress fields from job (used by list refresh). */
  async syncDocumentFromJob(documentId: string): Promise<Document | null> {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.sourceType !== 'audio') return doc;

    const job = await this.latestJob(documentId);
    if (!job) return doc;

    // Once RAGFlow id is set and parse is running/done, leave status to RAGFlow refresh
    // unless job is still pre-RAG (queued/running without terminal).
    if (doc.ragflowDocumentId && (job.status === 'done' || job.stage === 'parsing' || job.stage === 'done')) {
      return doc;
    }

    let status = doc.status;
    let progress = doc.progress;
    let progressMsg = job.progressMsg ?? doc.progressMsg;
    let errorMessage = doc.errorMessage;

    if (job.status === 'queued') {
      status = 'unstart';
      progress = 0;
      progressMsg = job.progressMsg || 'Queued for transcription';
      errorMessage = null;
    } else if (job.status === 'running') {
      status = 'running';
      progress = job.progress || 0.05;
      progressMsg = job.progressMsg || `Transcribing (${job.stage})…`;
      errorMessage = null;
    } else if (job.status === 'failed' || job.status === 'cancelled') {
      status = 'fail';
      progress = job.progress || 0;
      progressMsg = job.progressMsg || (job.status === 'cancelled' ? 'Cancelled' : 'Failed');
      errorMessage = job.errorMessage;
    } else if (job.status === 'done' && !doc.ragflowDocumentId) {
      // Should be rare: job done but no RF id yet
      status = 'running';
      progressMsg = job.progressMsg || 'Finishing…';
    }

    if (
      status === doc.status &&
      progress === doc.progress &&
      progressMsg === doc.progressMsg &&
      errorMessage === doc.errorMessage
    ) {
      return doc;
    }

    return this.prisma.document.update({
      where: { id: documentId },
      data: { status, progress, progressMsg, errorMessage },
    });
  }

  async cancelJobsForDocument(documentId: string): Promise<void> {
    try {
      await this.prisma.transcriptionJob.updateMany({
        where: {
          documentId,
          status: { in: ['queued', 'running'] },
        },
        data: {
          status: 'cancelled',
          progressMsg: 'Cancelled (document deleted)',
          errorMessage: 'Document deleted',
          finishedAt: new Date(),
          lockedBy: null,
        },
      });
    } catch (e) {
      this.logger.warn(
        `cancelJobsForDocument ${documentId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
