import { Injectable } from '@nestjs/common';
import { DocumentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { badRequest, notFound } from '../common/errors';
import {
  assertWithinStorageQuota,
  withUserStorageLock,
} from '../common/storage-quota';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
    private readonly knowledge: KnowledgeService,
  ) {}

  private serialize(doc: {
    id: string;
    knowledgeBaseId: string;
    name: string;
    sizeBytes: bigint;
    status: DocumentStatus;
    progress: number;
    progressMsg: string | null;
    chunkCount: number;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
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
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  async list(userId: string, knowledgeBaseId: string) {
    await this.knowledge.getReadable(userId, knowledgeBaseId);
    const docs = await this.prisma.document.findMany({
      where: { knowledgeBaseId },
      orderBy: { createdAt: 'desc' },
    });
    // refresh running docs opportunistically
    await Promise.all(
      docs
        .filter((d) => d.status === 'running' || d.status === 'unstart')
        .slice(0, 10)
        .map((d) => this.refreshStatus(userId, knowledgeBaseId, d.id).catch(() => null)),
    );
    const fresh = await this.prisma.document.findMany({
      where: { knowledgeBaseId },
      orderBy: { createdAt: 'desc' },
    });
    return fresh.map((d) => this.serialize(d));
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

  async upload(
    userId: string,
    knowledgeBaseId: string,
    file: { originalname: string; buffer: Buffer; size: number; mimetype?: string },
  ) {
    const kb = await this.knowledge.getEditable(userId, knowledgeBaseId);
    if (!file?.buffer?.length) throw badRequest('file is required');
    const maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
    if (file.size > maxBytes) throw badRequest(`file exceeds max size ${maxBytes}`);

    // Lock + re-check quota around remote upload + insert (TOCTOU).
    return withUserStorageLock(this.prisma, userId, async () => {
      await assertWithinStorageQuota(this.prisma, userId, file.size);

      const safeName =
        file.originalname.replace(/[\\/]/g, '_').slice(0, 200) || 'upload.bin';
      const uploaded = await this.ragflow.uploadDocuments(kb.ragflowDatasetId, [
        {
          filename: safeName,
          buffer: file.buffer,
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
          sizeBytes: BigInt(rfDoc.size ?? file.size),
          status: 'unstart',
          progress: 0,
        },
      });
      return this.serialize(doc);
    });
  }

  async parse(userId: string, knowledgeBaseId: string, docId: string) {
    const kb = await this.knowledge.getEditable(userId, knowledgeBaseId);
    const doc = await this.getInEditableKb(userId, knowledgeBaseId, docId);
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
    return this.serialize(updated);
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

    const targets = docs.filter((d) => d.status !== 'running');
    if (!targets.length) {
      return { ok: true as const, count: 0, skipped: docs.length, items: [] };
    }

    await this.ragflow.parseDocuments(
      kb.ragflowDatasetId,
      targets.map((d) => d.ragflowDocumentId),
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
    return {
      ok: true as const,
      count: updated.length,
      skipped: docs.length - targets.length,
      items: updated.map((d) => this.serialize(d)),
    };
  }

  async stopParse(userId: string, knowledgeBaseId: string, docId: string) {
    const kb = await this.knowledge.getEditable(userId, knowledgeBaseId);
    const doc = await this.getInEditableKb(userId, knowledgeBaseId, docId);
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
    return this.serialize(updated);
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

    const targets = docs.filter((d) => d.status === 'running');
    if (!targets.length) {
      return { ok: true as const, count: 0, skipped: docs.length, items: [] };
    }

    await this.ragflow.stopParseDocuments(
      kb.ragflowDatasetId,
      targets.map((d) => d.ragflowDocumentId),
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
      where: { id: { in: targets.map((d) => d.id) } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      ok: true as const,
      count: updated.length,
      skipped: docs.length - targets.length,
      items: updated.map((d) => this.serialize(d)),
    };
  }

  async refreshStatus(userId: string, knowledgeBaseId: string, docId: string) {
    const kb = await this.knowledge.getReadable(userId, knowledgeBaseId);
    const doc = await this.getInReadableKb(userId, knowledgeBaseId, docId);
    const rf = await this.ragflow.getDocument(kb.ragflowDatasetId, doc.ragflowDocumentId);
    if (!rf) return this.serialize(doc);

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
        name: rf.name || doc.name,
      },
    });
    return this.serialize(updated);
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
    const result = await this.ragflow.listChunks(kb.ragflowDatasetId, doc.ragflowDocumentId, opts);
    if (result.total !== doc.chunkCount) {
      await this.prisma.document.update({
        where: { id: doc.id },
        data: { chunkCount: result.total },
      });
    }
    return {
      document: this.serialize({ ...doc, chunkCount: result.total }),
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
    try {
      await this.ragflow.deleteDocuments(kb.ragflowDatasetId, [doc.ragflowDocumentId]);
    } catch {
      // continue
    }
    await this.prisma.document.delete({ where: { id: doc.id } });
    return { ok: true };
  }
}
