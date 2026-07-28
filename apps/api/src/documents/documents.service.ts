import { Injectable } from '@nestjs/common';
import {
  Document,
  DocumentSourceType,
  TranscriptionJob,
} from '@prisma/client';
import * as fs from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { badRequest, notFound } from '../common/errors';
import {
  assertWithinStorageQuota,
  withUserStorageLock,
} from '../common/storage-quota';
import { isAudioUpload, extensionOf } from '../transcription/audio-formats';
import { MediaStorage } from '../transcription/media-storage';
import { SttClient } from '../transcription/stt.client';
import { TranscriptionService } from '../transcription/transcription.service';
import { probeDurationSeconds } from '../transcription/duration-probe';

type DocWithJob = Document & {
  transcriptionJobs?: TranscriptionJob[];
};

/** Upload payload: disk path preferred (P1); buffer supported for tests/admin. */
export type UploadFileInput = {
  originalname: string;
  size: number;
  mimetype?: string;
  /** Absolute path from multer diskStorage */
  path?: string;
  /** In-memory bytes (legacy / tests) */
  buffer?: Buffer;
};

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
    private readonly knowledge: KnowledgeService,
    private readonly media: MediaStorage,
    private readonly stt: SttClient,
    private readonly transcription: TranscriptionService,
  ) {}

  private serialize(
    doc: DocWithJob,
    job?: TranscriptionJob | null,
  ) {
    const latestJob =
      job ??
      (doc.transcriptionJobs && doc.transcriptionJobs.length
        ? doc.transcriptionJobs[0]
        : null);
    return {
      id: doc.id,
      knowledgeBaseId: doc.knowledgeBaseId,
      name: doc.name,
      sizeBytes: Number(doc.sizeBytes),
      status: doc.status,
      progress: doc.progress,
      progressMsg: doc.progressMsg,
      chunkCount: doc.chunkCount,
      errorMessage: doc.errorMessage,
      sourceType: doc.sourceType as DocumentSourceType,
      durationSeconds: doc.durationSeconds ?? null,
      transcriptLanguage: doc.transcriptLanguage ?? null,
      ragflowDocumentId: doc.ragflowDocumentId ?? null,
      transcription: this.transcription.summarize(latestJob),
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  private async loadJobMap(documentIds: string[]) {
    if (!documentIds.length) return new Map<string, TranscriptionJob>();
    const jobs = await this.prisma.transcriptionJob.findMany({
      where: { documentId: { in: documentIds } },
      orderBy: { createdAt: 'desc' },
    });
    const map = new Map<string, TranscriptionJob>();
    for (const j of jobs) {
      if (!map.has(j.documentId)) map.set(j.documentId, j);
    }
    return map;
  }

  async list(userId: string, knowledgeBaseId: string) {
    await this.knowledge.getReadable(userId, knowledgeBaseId);
    const docs = await this.prisma.document.findMany({
      where: { knowledgeBaseId },
      orderBy: { createdAt: 'desc' },
    });
    // refresh running / unstart docs opportunistically
    await Promise.all(
      docs
        .filter((d) => d.status === 'running' || d.status === 'unstart')
        .slice(0, 10)
        .map((d) =>
          this.refreshStatus(userId, knowledgeBaseId, d.id).catch(() => null),
        ),
    );
    const fresh = await this.prisma.document.findMany({
      where: { knowledgeBaseId },
      orderBy: { createdAt: 'desc' },
    });
    const jobMap = await this.loadJobMap(fresh.map((d) => d.id));
    return fresh.map((d) => this.serialize(d, jobMap.get(d.id)));
  }

  /** Document in a readable KB (any doc in the KB, not only uploader's). */
  async getInReadableKb(userId: string, knowledgeBaseId: string, docId: string) {
    await this.knowledge.getReadable(userId, knowledgeBaseId);
    const doc = await this.prisma.document.findFirst({
      where: { id: docId, knowledgeBaseId },
    });
    if (!doc) throw notFound('document not found');
    return doc;
  }

  /** Document in a content-editable KB. */
  async getInEditableKb(userId: string, knowledgeBaseId: string, docId: string) {
    await this.knowledge.getEditable(userId, knowledgeBaseId);
    const doc = await this.prisma.document.findFirst({
      where: { id: docId, knowledgeBaseId },
    });
    if (!doc) throw notFound('document not found');
    return doc;
  }

  /** @deprecated use getInReadableKb / getInEditableKb */
  async getOwned(userId: string, knowledgeBaseId: string, docId: string) {
    return this.getInEditableKb(userId, knowledgeBaseId, docId);
  }

  private maxAudioBytes(): number {
    // Spec default 500 MiB when unset
    return Number(process.env.MAX_AUDIO_UPLOAD_BYTES || 524288000);
  }

  private resolveUploadBytes(file: UploadFileInput): {
    size: number;
    hasPayload: boolean;
  } {
    if (file.path && fs.existsSync(file.path)) {
      const st = fs.statSync(file.path);
      return { size: st.size || file.size || 0, hasPayload: st.size > 0 };
    }
    if (file.buffer?.length) {
      return { size: file.buffer.length, hasPayload: true };
    }
    return { size: file.size || 0, hasPayload: false };
  }

  async upload(
    userId: string,
    knowledgeBaseId: string,
    file: UploadFileInput,
    opts?: { language?: string | null },
  ) {
    const kb = await this.knowledge.getEditable(userId, knowledgeBaseId);
    const { size, hasPayload } = this.resolveUploadBytes(file);
    if (!hasPayload) {
      this.media.removeTempFile(file.path);
      throw badRequest('file is required');
    }

    const audio = isAudioUpload(file.originalname, file.mimetype);
    if (audio) {
      return this.uploadAudio(userId, kb, { ...file, size }, opts);
    }

    const maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
    if (size > maxBytes) {
      this.media.removeTempFile(file.path);
      throw badRequest(`file exceeds max size ${maxBytes}`);
    }

    // Lock + re-check quota around remote upload + insert (TOCTOU).
    try {
      return await withUserStorageLock(this.prisma, userId, async () => {
        await assertWithinStorageQuota(this.prisma, userId, size);

        const safeName =
          file.originalname.replace(/[\\/]/g, '_').slice(0, 200) || 'upload.bin';
        // Small docs: load into memory once for RAGFlow multipart
        const buffer =
          file.buffer?.length
            ? file.buffer
            : fs.readFileSync(file.path!);
        const uploaded = await this.ragflow.uploadDocuments(kb.ragflowDatasetId, [
          {
            filename: safeName,
            buffer,
            mimetype: file.mimetype,
          },
        ]);
        const rfDoc = uploaded[0];
        if (!rfDoc?.id) throw badRequest('RAGFlow upload failed');

        const doc = await this.prisma.document.create({
          data: {
            knowledgeBaseId: kb.id,
            ownerUserId: userId,
            ragflowDocumentId: rfDoc.id,
            name: rfDoc.name || safeName,
            sizeBytes: BigInt(rfDoc.size ?? size),
            status: 'unstart',
            progress: 0,
            sourceType: 'file',
          },
        });
        return this.serialize(doc, null);
      });
    } finally {
      this.media.removeTempFile(file.path);
    }
  }

  private async uploadAudio(
    userId: string,
    kb: { id: string; ragflowDatasetId: string },
    file: UploadFileInput,
    opts?: { language?: string | null },
  ) {
    this.stt.assertConfigured();

    const limit = this.maxAudioBytes();
    if (file.size > limit) {
      this.media.removeTempFile(file.path);
      throw badRequest(`audio file exceeds max size ${limit} bytes`);
    }

    return withUserStorageLock(this.prisma, userId, async () => {
      await assertWithinStorageQuota(this.prisma, userId, file.size);

      const safeName =
        file.originalname.replace(/[\\/]/g, '_').slice(0, 200) || 'audio.bin';
      const displayName = safeName.replace(/\.[^.]+$/, '') || safeName;
      const ext = extensionOf(safeName) || 'bin';
      const language =
        (opts?.language || process.env.STT_DEFAULT_LANGUAGE || 'zh')?.trim() ||
        null;

      // Create document first to get UUID for media path
      const doc = await this.prisma.document.create({
        data: {
          knowledgeBaseId: kb.id,
          ownerUserId: userId,
          ragflowDocumentId: null,
          name: displayName,
          sizeBytes: BigInt(file.size),
          status: 'unstart',
          progress: 0,
          progressMsg: 'Queued for transcription',
          sourceType: 'audio',
          mediaContentType: file.mimetype || null,
          transcriptLanguage: language,
        },
      });

      try {
        let relativePath: string;
        let absolutePath: string;
        if (file.path && fs.existsSync(file.path)) {
          // P1: rename/move from multer temp into final media path (no second full RAM copy)
          ({ relativePath, absolutePath } = this.media.placeSourceFromTemp(
            userId,
            doc.id,
            ext,
            file.path,
          ));
        } else if (file.buffer?.length) {
          ({ relativePath, absolutePath } = this.media.writeSourceAudio(
            userId,
            doc.id,
            ext,
            file.buffer,
          ));
        } else {
          throw badRequest('file is required');
        }

        // Best-effort early duration (non-blocking for queue; failure is fine)
        const duration = await probeDurationSeconds(absolutePath);

        const updated = await this.prisma.document.update({
          where: { id: doc.id },
          data: {
            mediaPath: relativePath,
            ...(duration != null ? { durationSeconds: duration } : {}),
          },
        });
        const job = await this.transcription.enqueueForDocument(updated, {
          language,
        });
        const finalDoc = await this.prisma.document.findUniqueOrThrow({
          where: { id: doc.id },
        });
        return this.serialize(finalDoc, job);
      } catch (e) {
        // Cleanup on failure (temp may already be moved)
        this.media.removeTempFile(file.path);
        this.media.removeDocDir(userId, doc.id);
        await this.prisma.document.delete({ where: { id: doc.id } }).catch(() => null);
        throw e;
      }
    });
  }

  async cancelTranscription(userId: string, knowledgeBaseId: string, docId: string) {
    const result = await this.transcription.cancel(userId, knowledgeBaseId, docId);
    const doc = await this.getInEditableKb(userId, knowledgeBaseId, docId);
    return this.serialize(doc, await this.transcription.latestJob(doc.id));
  }

  async retryTranscription(userId: string, knowledgeBaseId: string, docId: string) {
    const job = await this.transcription.retry(userId, knowledgeBaseId, docId);
    const doc = await this.getInEditableKb(userId, knowledgeBaseId, docId);
    return this.serialize(doc, job);
  }

  async parse(userId: string, knowledgeBaseId: string, docId: string) {
    const kb = await this.knowledge.getEditable(userId, knowledgeBaseId);
    const doc = await this.getInEditableKb(userId, knowledgeBaseId, docId);
    if (!doc.ragflowDocumentId) {
      throw badRequest(
        'document is not ready for parse (audio still transcribing or failed)',
      );
    }
    await this.ragflow.parseDocuments(kb.ragflowDatasetId, [doc.ragflowDocumentId]);
    const updated = await this.prisma.document.update({
      where: { id: doc.id },
      data: {
        status: 'running',
        progress: 0.05,
        progressMsg: 'Parse started',
        errorMessage: null,
      },
    });
    return this.serialize(updated, await this.transcription.latestJob(updated.id));
  }

  /**
   * Start parse for multiple documents in one RAGFlow call.
   * Skips docs already `running`. Re-parses `done`/`fail`/`unstart`.
   */
  async batchParse(userId: string, knowledgeBaseId: string, documentIds: string[]) {
    if (!documentIds?.length) throw badRequest('documentIds is required');
    const uniqueIds = [...new Set(documentIds.filter(Boolean))];
    if (!uniqueIds.length) throw badRequest('documentIds is required');

    const kb = await this.knowledge.getEditable(userId, knowledgeBaseId);
    const docs = await this.prisma.document.findMany({
      where: { knowledgeBaseId, id: { in: uniqueIds } },
    });
    if (!docs.length) throw notFound('document not found');

    const targets = docs.filter(
      (d) => d.status !== 'running' && d.ragflowDocumentId,
    );
    if (!targets.length) {
      return { ok: true as const, count: 0, skipped: docs.length, items: [] };
    }

    await this.ragflow.parseDocuments(
      kb.ragflowDatasetId,
      targets.map((d) => d.ragflowDocumentId!),
    );
    await this.prisma.document.updateMany({
      where: { id: { in: targets.map((d) => d.id) } },
      data: {
        status: 'running',
        progress: 0.05,
        progressMsg: 'Parse started',
        errorMessage: null,
      },
    });
    const updated = await this.prisma.document.findMany({
      where: { id: { in: targets.map((d) => d.id) } },
      orderBy: { createdAt: 'desc' },
    });
    const jobMap = await this.loadJobMap(updated.map((d) => d.id));
    return {
      ok: true as const,
      count: updated.length,
      skipped: docs.length - targets.length,
      items: updated.map((d) => this.serialize(d, jobMap.get(d.id))),
    };
  }

  async stopParse(userId: string, knowledgeBaseId: string, docId: string) {
    const kb = await this.knowledge.getEditable(userId, knowledgeBaseId);
    const doc = await this.getInEditableKb(userId, knowledgeBaseId, docId);

    // If audio still in STT (no RF id), cancel transcription instead
    if (!doc.ragflowDocumentId && doc.sourceType === 'audio') {
      return this.cancelTranscription(userId, knowledgeBaseId, docId);
    }
    if (!doc.ragflowDocumentId) {
      throw badRequest('document has no RAGFlow id');
    }

    await this.ragflow.stopParseDocuments(kb.ragflowDatasetId, [doc.ragflowDocumentId]);
    const updated = await this.prisma.document.update({
      where: { id: doc.id },
      data: {
        status: 'unstart',
        progress: 0,
        progressMsg: 'Parse stopped',
        errorMessage: null,
      },
    });
    return this.serialize(updated, await this.transcription.latestJob(updated.id));
  }

  /** Stop parse for multiple documents in one RAGFlow call. Only affects `running`. */
  async batchStopParse(userId: string, knowledgeBaseId: string, documentIds: string[]) {
    if (!documentIds?.length) throw badRequest('documentIds is required');
    const uniqueIds = [...new Set(documentIds.filter(Boolean))];
    if (!uniqueIds.length) throw badRequest('documentIds is required');

    const kb = await this.knowledge.getEditable(userId, knowledgeBaseId);
    const docs = await this.prisma.document.findMany({
      where: { knowledgeBaseId, id: { in: uniqueIds } },
    });
    if (!docs.length) throw notFound('document not found');

    const targets = docs.filter((d) => d.status === 'running' && d.ragflowDocumentId);
    // Also cancel audio STT jobs without RF id
    for (const d of docs) {
      if (d.sourceType === 'audio' && !d.ragflowDocumentId && d.status === 'running') {
        await this.transcription.cancel(userId, knowledgeBaseId, d.id).catch(() => null);
      }
    }

    if (!targets.length) {
      const jobMap = await this.loadJobMap(docs.map((d) => d.id));
      const fresh = await this.prisma.document.findMany({
        where: { id: { in: uniqueIds } },
      });
      return {
        ok: true as const,
        count: 0,
        skipped: docs.length,
        items: fresh.map((d) => this.serialize(d, jobMap.get(d.id))),
      };
    }

    await this.ragflow.stopParseDocuments(
      kb.ragflowDatasetId,
      targets.map((d) => d.ragflowDocumentId!),
    );
    await this.prisma.document.updateMany({
      where: { id: { in: targets.map((d) => d.id) } },
      data: {
        status: 'unstart',
        progress: 0,
        progressMsg: 'Parse stopped',
        errorMessage: null,
      },
    });
    const updated = await this.prisma.document.findMany({
      where: { id: { in: uniqueIds } },
      orderBy: { createdAt: 'desc' },
    });
    const jobMap = await this.loadJobMap(updated.map((d) => d.id));
    return {
      ok: true as const,
      count: targets.length,
      skipped: docs.length - targets.length,
      items: updated.map((d) => this.serialize(d, jobMap.get(d.id))),
    };
  }

  async refreshStatus(userId: string, knowledgeBaseId: string, docId: string) {
    await this.knowledge.getReadable(userId, knowledgeBaseId);
    let doc = await this.getInReadableKb(userId, knowledgeBaseId, docId);

    // Audio without RAGFlow id: refresh from job, not RAGFlow
    if (doc.sourceType === 'audio' && !doc.ragflowDocumentId) {
      doc = (await this.transcription.syncDocumentFromJob(doc.id)) || doc;
      return this.serialize(doc, await this.transcription.latestJob(doc.id));
    }

    if (!doc.ragflowDocumentId) {
      return this.serialize(doc, await this.transcription.latestJob(doc.id));
    }

    const kb = await this.knowledge.getReadable(userId, knowledgeBaseId);
    const rf = await this.ragflow.getDocument(kb.ragflowDatasetId, doc.ragflowDocumentId);
    if (!rf) {
      return this.serialize(doc, await this.transcription.latestJob(doc.id));
    }

    let status = this.ragflow.mapRunToStatus(rf.run);
    // If chunks already exist, treat as done
    if (status !== 'done' && status !== 'fail') {
      const listed = await this.ragflow.listChunks(kb.ragflowDatasetId, doc.ragflowDocumentId, {
        page: 1,
        pageSize: 1,
      });
      if (listed.total > 0 && (rf.progress ?? 0) >= 1) status = 'done';
      if (listed.total > 0 && status === 'unstart') {
        // keep unstart until parse called; don't flip solely on chunks in real mode
      }
    }

    const progress =
      typeof rf.progress === 'number' ? rf.progress : status === 'done' ? 1 : doc.progress;
    const chunkCount =
      typeof rf.chunk_count === 'number'
        ? rf.chunk_count
        : (
            await this.ragflow.listChunks(kb.ragflowDatasetId, doc.ragflowDocumentId, {
              page: 1,
              pageSize: 1,
            })
          ).total;

    const updated = await this.prisma.document.update({
      where: { id: doc.id },
      data: {
        status,
        progress,
        progressMsg: rf.progress_msg || doc.progressMsg,
        chunkCount: chunkCount || doc.chunkCount,
        name: doc.sourceType === 'audio' ? doc.name : rf.name || doc.name,
      },
    });
    return this.serialize(updated, await this.transcription.latestJob(updated.id));
  }

  async get(userId: string, knowledgeBaseId: string, docId: string) {
    return this.refreshStatus(userId, knowledgeBaseId, docId);
  }

  async chunks(
    userId: string,
    knowledgeBaseId: string,
    docId: string,
    opts: { page?: number; pageSize?: number; keywords?: string },
  ) {
    const kb = await this.knowledge.getReadable(userId, knowledgeBaseId);
    const doc = await this.getInReadableKb(userId, knowledgeBaseId, docId);
    if (!doc.ragflowDocumentId) {
      return {
        document: this.serialize(doc, await this.transcription.latestJob(doc.id)),
        chunks: [],
        total: 0,
        page: opts.page || 1,
        pageSize: opts.pageSize || 20,
      };
    }
    const result = await this.ragflow.listChunks(kb.ragflowDatasetId, doc.ragflowDocumentId, opts);
    if (result.total !== doc.chunkCount) {
      await this.prisma.document.update({
        where: { id: doc.id },
        data: { chunkCount: result.total },
      });
    }
    return {
      document: this.serialize(
        { ...doc, chunkCount: result.total },
        await this.transcription.latestJob(doc.id),
      ),
      chunks: result.chunks.map((c) => ({
        id: c.id,
        content: c.content || c.content_with_weight || '',
        available: c.available ?? true,
        importantKeywords: c.important_keywords || [],
        // RAGFlow: [pageNumber, x1, x2, y1, y2] for PDF highlight
        positions: Array.isArray(c.positions) ? c.positions : [],
        imageId: c.image_id || undefined,
      })),
      total: result.total,
      page: opts.page || 1,
      pageSize: opts.pageSize || 20,
    };
  }

  async preview(
    userId: string,
    knowledgeBaseId: string,
    docId: string,
    pageSize = 30,
  ) {
    const document = await this.refreshStatus(userId, knowledgeBaseId, docId);
    const chunkPage = await this.chunks(userId, knowledgeBaseId, docId, {
      page: 1,
      pageSize,
    });
    return {
      document,
      chunks: chunkPage.chunks,
      totalChunks: chunkPage.total,
    };
  }

  async downloadFile(userId: string, knowledgeBaseId: string, docId: string) {
    const kb = await this.knowledge.getReadable(userId, knowledgeBaseId);
    const doc = await this.getInReadableKb(userId, knowledgeBaseId, docId);
    if (!doc.ragflowDocumentId) {
      throw badRequest('file not available yet (transcription in progress)');
    }
    const file = await this.ragflow.downloadDocument(
      kb.ragflowDatasetId,
      doc.ragflowDocumentId,
    );
    return {
      buffer: file.buffer,
      contentType: file.contentType,
      filename: file.filename || doc.name,
    };
  }

  async remove(userId: string, knowledgeBaseId: string, docId: string) {
    const kb = await this.knowledge.getEditable(userId, knowledgeBaseId);
    const doc = await this.getInEditableKb(userId, knowledgeBaseId, docId);

    await this.transcription.cancelJobsForDocument(doc.id);

    if (doc.ragflowDocumentId) {
      try {
        await this.ragflow.deleteDocuments(kb.ragflowDatasetId, [doc.ragflowDocumentId]);
      } catch {
        // continue
      }
    }

    if (doc.sourceType === 'audio') {
      this.media.removeDocDir(doc.ownerUserId, doc.id);
    }

    await this.prisma.document.delete({ where: { id: doc.id } });
    return { ok: true };
  }
}
