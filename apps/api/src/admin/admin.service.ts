import { Injectable } from '@nestjs/common';
import { DocumentStatus, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { AgentSessionPool } from '../agent/agent-session.pool';
import { badRequest, notFound } from '../common/errors';
import {
  assertWithinStorageQuota,
  defaultStorageQuotaBytes,
  parseQuotaBytesInput,
  withUserStorageLock,
} from '../common/storage-quota';

const BCRYPT_ROUNDS = 10;

function pageParams(page?: number, pageSize?: number) {
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(100, Math.max(1, Number(pageSize) || 10));
  return { page: p, pageSize: ps, skip: (p - 1) * ps };
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
    private readonly agentPool: AgentSessionPool,
  ) {}

  // ── Datasets (knowledge bases) ──────────────────────────────────────────

  async listDatasets(query: {
    page?: number;
    pageSize?: number;
    name?: string;
    owner?: string;
    chunkMethod?: string;
  }) {
    const { page, pageSize, skip } = pageParams(query.page, query.pageSize);
    const where: Record<string, unknown> = {};
    if (query.name?.trim()) {
      where.name = { contains: query.name.trim(), mode: 'insensitive' };
    }
    if (query.chunkMethod?.trim()) {
      where.chunkMethod = query.chunkMethod.trim();
    }
    if (query.owner?.trim()) {
      where.owner = {
        username: { contains: query.owner.trim(), mode: 'insensitive' },
      };
    }

    const [total, rows] = await Promise.all([
      this.prisma.knowledgeBase.count({ where }),
      this.prisma.knowledgeBase.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          owner: { select: { id: true, username: true } },
          documents: { select: { chunkCount: true } },
          _count: { select: { documents: true } },
        },
      }),
    ]);

    return {
      items: rows.map((kb) => ({
        id: kb.id,
        name: kb.name,
        description: kb.description,
        chunkMethod: kb.chunkMethod,
        visibility: kb.visibility,
        documentCount: kb._count.documents,
        chunkCount: kb.documents.reduce((s, d) => s + (d.chunkCount || 0), 0),
        ownerUserId: kb.ownerUserId,
        ownerUsername: kb.owner.username,
        createdAt: kb.createdAt.toISOString(),
        updatedAt: kb.updatedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async batchDeleteDatasets(ids: string[]) {
    if (!ids?.length) throw badRequest('ids is required');
    const kbs = await this.prisma.knowledgeBase.findMany({
      where: { id: { in: ids } },
    });
    for (const kb of kbs) {
      try {
        await this.ragflow.deleteDatasets([kb.ragflowDatasetId]);
      } catch {
        // still remove local so admin is not stuck
      }
    }
    const result = await this.prisma.knowledgeBase.deleteMany({
      where: { id: { in: ids } },
    });
    return { ok: true, deleted: result.count };
  }

  private async getKbById(kbId: string) {
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      include: { owner: { select: { id: true, username: true } } },
    });
    if (!kb) throw notFound('knowledge base not found');
    return kb;
  }

  // ── Documents ───────────────────────────────────────────────────────────

  private serializeDoc(doc: {
    id: string;
    knowledgeBaseId: string;
    ownerUserId: string;
    name: string;
    sizeBytes: bigint;
    status: DocumentStatus;
    progress: number;
    progressMsg: string | null;
    chunkCount: number;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
    knowledgeBase?: { name: string };
    owner?: { username: string };
  }) {
    return {
      id: doc.id,
      knowledgeBaseId: doc.knowledgeBaseId,
      knowledgeBaseName: doc.knowledgeBase?.name,
      ownerUserId: doc.ownerUserId,
      ownerUsername: doc.owner?.username,
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

  async listDocuments(
    kbId: string,
    query: {
      page?: number;
      pageSize?: number;
      keywords?: string;
      status?: string;
    },
  ) {
    await this.getKbById(kbId);
    const { page, pageSize, skip } = pageParams(query.page, query.pageSize);
    const where: Record<string, unknown> = { knowledgeBaseId: kbId };
    if (query.keywords?.trim()) {
      where.name = { contains: query.keywords.trim(), mode: 'insensitive' };
    }
    if (query.status?.trim()) {
      where.status = query.status.trim() as DocumentStatus;
    }

    // Refresh a few running docs before list
    const running = await this.prisma.document.findMany({
      where: {
        knowledgeBaseId: kbId,
        status: { in: ['running', 'unstart'] },
      },
      take: 10,
      orderBy: { updatedAt: 'desc' },
    });
    await Promise.all(
      running.map((d) => this.refreshDocStatus(d.id).catch(() => null)),
    );

    const [total, rows] = await Promise.all([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          knowledgeBase: { select: { name: true } },
          owner: { select: { username: true } },
        },
      }),
    ]);

    return {
      items: rows.map((d) => this.serializeDoc(d)),
      total,
      page,
      pageSize,
    };
  }

  async uploadDocument(
    kbId: string,
    file: { originalname: string; buffer: Buffer; size: number; mimetype?: string },
  ) {
    const kb = await this.getKbById(kbId);
    if (!file?.buffer?.length) throw badRequest('file is required');
    const maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
    if (file.size > maxBytes) throw badRequest(`file exceeds max size ${maxBytes}`);

    // Charge KB owner; lock that user so concurrent admin/user uploads cannot race quota.
    return withUserStorageLock(this.prisma, kb.ownerUserId, async () => {
      await assertWithinStorageQuota(this.prisma, kb.ownerUserId, file.size);

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
          ownerUserId: kb.ownerUserId,
          ragflowDocumentId: rfDoc.id,
          name: rfDoc.name || safeName,
          sizeBytes: BigInt(rfDoc.size ?? file.size),
          status: 'unstart',
          progress: 0,
        },
        include: {
          knowledgeBase: { select: { name: true } },
          owner: { select: { username: true } },
        },
      });
      return this.serializeDoc(doc);
    });
  }

  async parseDocuments(kbId: string, documentIds: string[]) {
    if (!documentIds?.length) throw badRequest('documentIds is required');
    const kb = await this.getKbById(kbId);
    const docs = await this.prisma.document.findMany({
      where: { knowledgeBaseId: kbId, id: { in: documentIds } },
    });
    if (!docs.length) throw notFound('document not found');

    const withRf = docs.filter((d) => d.ragflowDocumentId);
    if (!withRf.length) {
      return { ok: true, count: 0 };
    }
    const rfIds = withRf.map((d) => d.ragflowDocumentId!);
    await this.ragflow.parseDocuments(kb.ragflowDatasetId, rfIds);
    await this.prisma.document.updateMany({
      where: { id: { in: withRf.map((d) => d.id) } },
      data: {
        status: 'running',
        progress: 0.05,
        progressMsg: 'Parse started',
        errorMessage: null,
      },
    });
    return { ok: true, count: withRf.length };
  }

  async stopParseDocuments(kbId: string, documentIds: string[]) {
    if (!documentIds?.length) throw badRequest('documentIds is required');
    const kb = await this.getKbById(kbId);
    const docs = await this.prisma.document.findMany({
      where: { knowledgeBaseId: kbId, id: { in: documentIds } },
    });
    if (!docs.length) throw notFound('document not found');

    const withRf = docs.filter((d) => d.ragflowDocumentId);
    if (withRf.length) {
      await this.ragflow.stopParseDocuments(
        kb.ragflowDatasetId,
        withRf.map((d) => d.ragflowDocumentId!),
      );
      await this.prisma.document.updateMany({
        where: { id: { in: withRf.map((d) => d.id) } },
        data: {
          status: 'unstart',
          progress: 0,
          progressMsg: 'Parse stopped',
          errorMessage: null,
        },
      });
    }
    return { ok: true, count: withRf.length };
  }

  async batchDeleteDocuments(kbId: string, ids: string[]) {
    if (!ids?.length) throw badRequest('ids is required');
    const kb = await this.getKbById(kbId);
    const docs = await this.prisma.document.findMany({
      where: { knowledgeBaseId: kbId, id: { in: ids } },
    });
    if (docs.length) {
      const rfIds = docs.map((d) => d.ragflowDocumentId).filter(Boolean) as string[];
      if (rfIds.length) {
        try {
          await this.ragflow.deleteDocuments(kb.ragflowDatasetId, rfIds);
        } catch {
          // continue
        }
      }
    }
    const result = await this.prisma.document.deleteMany({
      where: { knowledgeBaseId: kbId, id: { in: ids } },
    });
    return { ok: true, deleted: result.count };
  }

  private async refreshDocStatus(docId: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id: docId },
      include: { knowledgeBase: true },
    });
    if (!doc) return null;
    if (!doc.ragflowDocumentId) return doc;
    const kb = doc.knowledgeBase;
    const rf = await this.ragflow.getDocument(
      kb.ragflowDatasetId,
      doc.ragflowDocumentId,
    );
    if (!rf) return doc;

    let status = this.ragflow.mapRunToStatus(rf.run);
    if (status !== 'done' && status !== 'fail') {
      const listed = await this.ragflow.listChunks(
        kb.ragflowDatasetId,
        doc.ragflowDocumentId,
        { page: 1, pageSize: 1 },
      );
      if (listed.total > 0 && (rf.progress ?? 0) >= 1) status = 'done';
    }

    const progress =
      typeof rf.progress === 'number'
        ? rf.progress
        : status === 'done'
          ? 1
          : doc.progress;
    const chunkCount =
      typeof rf.chunk_count === 'number'
        ? rf.chunk_count
        : (
            await this.ragflow.listChunks(
              kb.ragflowDatasetId,
              doc.ragflowDocumentId,
              { page: 1, pageSize: 1 },
            )
          ).total;

    return this.prisma.document.update({
      where: { id: doc.id },
      data: {
        status,
        progress,
        progressMsg: rf.progress_msg || doc.progressMsg,
        chunkCount: chunkCount || doc.chunkCount,
        name: rf.name || doc.name,
      },
    });
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  async listTasks(query: {
    page?: number;
    pageSize?: number;
    docName?: string;
    datasetName?: string;
    owner?: string;
    status?: string;
  }) {
    const { page, pageSize, skip } = pageParams(
      query.page,
      query.pageSize ?? 20,
    );
    const where: Record<string, unknown> = {};
    if (query.docName?.trim()) {
      where.name = { contains: query.docName.trim(), mode: 'insensitive' };
    }
    if (query.status?.trim()) {
      where.status = query.status.trim() as DocumentStatus;
    }
    if (query.datasetName?.trim()) {
      where.knowledgeBase = {
        name: { contains: query.datasetName.trim(), mode: 'insensitive' },
      };
    }
    if (query.owner?.trim()) {
      where.owner = {
        username: { contains: query.owner.trim(), mode: 'insensitive' },
      };
    }

    // Refresh some running tasks
    const running = await this.prisma.document.findMany({
      where: { status: 'running' },
      take: 15,
      orderBy: { updatedAt: 'desc' },
    });
    await Promise.all(
      running.map((d) => this.refreshDocStatus(d.id).catch(() => null)),
    );

    const [total, rows] = await Promise.all([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { updatedAt: 'desc' },
        include: {
          knowledgeBase: { select: { name: true } },
          owner: { select: { username: true } },
        },
      }),
    ]);

    return {
      items: rows.map((d) => this.serializeDoc(d)),
      total,
      page,
      pageSize,
    };
  }

  async taskStats() {
    const groups = await this.prisma.document.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts: Record<string, number> = {
      total: 0,
      running: 0,
      unstart: 0,
      done: 0,
      fail: 0,
      cancel: 0,
    };
    for (const g of groups) {
      const n = g._count._all;
      counts.total += n;
      if (g.status in counts) counts[g.status] = n;
    }
    return counts;
  }

  async batchParseTasks(
    tasks: Array<{ knowledgeBaseId: string; documentIds: string[] }>,
  ) {
    if (!tasks?.length) throw badRequest('tasks is required');
    let count = 0;
    for (const t of tasks) {
      if (!t.documentIds?.length) continue;
      const res = await this.parseDocuments(t.knowledgeBaseId, t.documentIds);
      count += res.count;
    }
    return { ok: true, count };
  }

  async batchStopTasks(
    tasks: Array<{ knowledgeBaseId: string; documentIds: string[] }>,
  ) {
    if (!tasks?.length) throw badRequest('tasks is required');
    let count = 0;
    for (const t of tasks) {
      if (!t.documentIds?.length) continue;
      const res = await this.stopParseDocuments(
        t.knowledgeBaseId,
        t.documentIds,
      );
      count += res.count;
    }
    return { ok: true, count };
  }

  async retryFailedTasks() {
    const failed = await this.prisma.document.findMany({
      where: { status: 'fail' },
      select: { id: true, knowledgeBaseId: true },
    });
    const groups = new Map<string, string[]>();
    for (const d of failed) {
      const list = groups.get(d.knowledgeBaseId) || [];
      list.push(d.id);
      groups.set(d.knowledgeBaseId, list);
    }
    let count = 0;
    for (const [kbId, documentIds] of groups) {
      const res = await this.parseDocuments(kbId, documentIds);
      count += res.count;
    }
    return { ok: true, retried: count };
  }

  // ── Users ───────────────────────────────────────────────────────────────

  async listUsers(query: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    status?: string;
  }) {
    const { page, pageSize, skip } = pageParams(query.page, query.pageSize);
    const where: Record<string, unknown> = {};
    if (query.keyword?.trim()) {
      where.username = {
        contains: query.keyword.trim(),
        mode: 'insensitive',
      };
    }
    if (query.status === 'active') {
      where.disabledAt = null;
    } else if (query.status === 'inactive') {
      where.disabledAt = { not: null };
    }

    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              knowledgeBases: true,
              documents: true,
              conversations: true,
            },
          },
        },
      }),
    ]);

    const userIds = rows.map((u) => u.id);
    const usedGroups =
      userIds.length === 0
        ? []
        : await this.prisma.document.groupBy({
            by: ['ownerUserId'],
            where: { ownerUserId: { in: userIds } },
            _sum: { sizeBytes: true },
          });
    const usedMap = new Map(
      usedGroups.map((g) => [g.ownerUserId, Number(g._sum.sizeBytes ?? 0n)]),
    );

    return {
      items: rows.map((u) => {
        const storageQuotaBytes = Number(u.storageQuotaBytes);
        const storageUsedBytes = usedMap.get(u.id) ?? 0;
        return {
          id: u.id,
          username: u.username,
          role: u.role,
          disabled: !!u.disabledAt,
          datasetCount: u._count.knowledgeBases,
          documentCount: u._count.documents,
          conversationCount: u._count.conversations,
          storageQuotaBytes,
          storageUsedBytes,
          storageRemainingBytes: Math.max(0, storageQuotaBytes - storageUsedBytes),
          createdAt: u.createdAt.toISOString(),
          updatedAt: u.updatedAt.toISOString(),
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  async createUser(body: {
    username: string;
    password: string;
    role?: Role;
    storageQuotaBytes?: number;
  }) {
    const uname = (body.username || '').trim();
    if (uname.length < 2) {
      throw badRequest('username must be at least 2 characters');
    }
    if (!body.password || body.password.length < 6) {
      throw badRequest('password must be at least 6 characters');
    }
    const role: Role = body.role === 'admin' ? 'admin' : 'user';
    const quota =
      body.storageQuotaBytes !== undefined
        ? parseQuotaBytesInput(body.storageQuotaBytes)!
        : defaultStorageQuotaBytes();
    const exists = await this.prisma.user.findUnique({
      where: { username: uname },
    });
    if (exists) throw badRequest('username already taken');

    const user = await this.prisma.user.create({
      data: {
        username: uname,
        passwordHash: await bcrypt.hash(body.password, BCRYPT_ROUNDS),
        role,
        storageQuotaBytes: BigInt(quota),
      },
    });
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      disabled: false,
      datasetCount: 0,
      documentCount: 0,
      conversationCount: 0,
      storageQuotaBytes: Number(user.storageQuotaBytes),
      storageUsedBytes: 0,
      storageRemainingBytes: Number(user.storageQuotaBytes),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  async setUserStorageQuota(userId: string, storageQuotaBytes: number) {
    const quota = parseQuotaBytesInput(storageQuotaBytes);
    if (quota === undefined) throw badRequest('storageQuotaBytes is required');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound('user not found');
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { storageQuotaBytes: BigInt(quota) },
    });
    const agg = await this.prisma.document.aggregate({
      where: { ownerUserId: userId },
      _sum: { sizeBytes: true },
    });
    const storageUsedBytes = Number(agg._sum.sizeBytes ?? 0n);
    const storageQuota = Number(updated.storageQuotaBytes);
    return {
      id: updated.id,
      username: updated.username,
      role: updated.role,
      disabled: !!updated.disabledAt,
      storageQuotaBytes: storageQuota,
      storageUsedBytes,
      storageRemainingBytes: Math.max(0, storageQuota - storageUsedBytes),
    };
  }

  private async assertNotLastAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound('user not found');
    if (user.role === 'admin') {
      const adminCount = await this.prisma.user.count({
        where: { role: 'admin', disabledAt: null },
      });
      if (adminCount <= 1 && !user.disabledAt) {
        throw badRequest('cannot modify the last active admin');
      }
    }
    return user;
  }

  async setUserStatus(
    actorUserId: string,
    userId: string,
    disabled: boolean,
  ) {
    if (actorUserId === userId && disabled) {
      throw badRequest('cannot disable your own account');
    }
    const user = await this.assertNotLastAdmin(userId);
    if (disabled && user.role === 'admin' && !user.disabledAt) {
      // assertNotLastAdmin already checked when demoting last admin
    }
    if (disabled) {
      await this.assertNotLastAdmin(userId);
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { disabledAt: disabled ? new Date() : null },
    });
    return {
      id: updated.id,
      username: updated.username,
      role: updated.role,
      disabled: !!updated.disabledAt,
    };
  }

  async setUserRole(actorUserId: string, userId: string, role: Role) {
    if (role !== 'user' && role !== 'admin') {
      throw badRequest('invalid role');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound('user not found');
    if (user.role === 'admin' && role === 'user') {
      if (actorUserId === userId) {
        throw badRequest('cannot demote your own account');
      }
      await this.assertNotLastAdmin(userId);
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { role },
    });
    return {
      id: updated.id,
      username: updated.username,
      role: updated.role,
      disabled: !!updated.disabledAt,
    };
  }

  async setUserPassword(userId: string, password: string) {
    if (!password || password.length < 6) {
      throw badRequest('password must be at least 6 characters');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound('user not found');
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) },
    });
    // Revoke sessions so password change takes effect
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async batchDeleteUsers(actorUserId: string, ids: string[]) {
    if (!ids?.length) throw badRequest('ids is required');
    if (ids.includes(actorUserId)) {
      throw badRequest('cannot delete your own account');
    }

    let deleted = 0;
    for (const id of ids) {
      const user = await this.prisma.user.findUnique({
        where: { id },
        include: { knowledgeBases: true },
      });
      if (!user) continue;
      if (user.role === 'admin') {
        const adminCount = await this.prisma.user.count({
          where: { role: 'admin', disabledAt: null },
        });
        if (adminCount <= 1 && !user.disabledAt) {
          throw badRequest('cannot delete the last active admin');
        }
      }
      for (const kb of user.knowledgeBases) {
        try {
          await this.ragflow.deleteDatasets([kb.ragflowDatasetId]);
        } catch {
          // continue
        }
      }
      await this.prisma.user.delete({ where: { id } });
      deleted += 1;
    }
    return { ok: true, deleted };
  }

  // ── Agent sessions (in-memory pool) ─────────────────────────────────────

  agentSessionStats() {
    return this.agentPool.stats();
  }

  async listAgentSessions(query: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    status?: string;
  }) {
    const { page, pageSize, skip } = pageParams(query.page, query.pageSize);
    const poolStats = this.agentPool.stats();
    let rows = this.agentPool.list();

    const status = query.status?.trim().toLowerCase();
    if (status === 'busy') {
      rows = rows.filter((s) => s.busy);
    } else if (status === 'idle') {
      rows = rows.filter((s) => !s.busy);
    }

    const keyword = query.keyword?.trim().toLowerCase();
    const conversationIds = rows.map((r) => r.conversationId);
    const userIds = [...new Set(rows.map((r) => r.userId))];

    const [conversations, users] = await Promise.all([
      conversationIds.length
        ? this.prisma.conversation.findMany({
            where: { id: { in: conversationIds } },
            select: {
              id: true,
              title: true,
              updatedAt: true,
              _count: { select: { messages: true } },
            },
          })
        : Promise.resolve([]),
      userIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true },
          })
        : Promise.resolve([]),
    ]);

    const convMap = new Map(conversations.map((c) => [c.id, c]));
    const userMap = new Map(users.map((u) => [u.id, u.username]));

    let items = rows.map((s) => {
      const conv = convMap.get(s.conversationId);
      return {
        conversationId: s.conversationId,
        conversationTitle: conv?.title || '—',
        userId: s.userId,
        ownerUsername: userMap.get(s.userId) || '—',
        busy: s.busy,
        isStreaming: s.isStreaming,
        messageCount: s.messageCount,
        dbMessageCount: conv?._count.messages ?? null,
        modelId: s.modelId,
        modelProvider: s.modelProvider,
        lastUsedAt: new Date(s.lastUsedAt).toISOString(),
        conversationUpdatedAt: conv?.updatedAt?.toISOString() ?? null,
      };
    });

    if (keyword) {
      items = items.filter(
        (s) =>
          s.conversationId.toLowerCase().includes(keyword) ||
          s.conversationTitle.toLowerCase().includes(keyword) ||
          s.ownerUsername.toLowerCase().includes(keyword) ||
          s.userId.toLowerCase().includes(keyword) ||
          (s.modelId || '').toLowerCase().includes(keyword),
      );
    }

    items.sort((a, b) => {
      if (a.busy !== b.busy) return a.busy ? -1 : 1;
      return (
        new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
      );
    });

    const total = items.length;
    const paged = items.slice(skip, skip + pageSize);

    return {
      items: paged,
      total,
      page,
      pageSize,
      stats: poolStats,
    };
  }

  disposeAgentSessions(conversationIds: string[]) {
    const ids = [...new Set(conversationIds.map((id) => id?.trim()).filter(Boolean))];
    if (!ids.length) throw badRequest('conversationIds is required');
    const disposed = this.agentPool.disposeMany(ids);
    return { ok: true, disposed };
  }
}
