import { Injectable } from '@nestjs/common';
import {
  KnowledgeBaseRole,
  KnowledgeBaseVisibility,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { badRequest, forbidden, notFound } from '../common/errors';
import {
  AddKnowledgeBaseMemberDto,
  CreateKnowledgeBaseDto,
  UpdateKnowledgeBaseDto,
  UpdateKnowledgeBaseMemberDto,
} from './knowledge.dto';

type KbWithAccess = {
  id: string;
  ownerUserId: string;
  name: string;
  description: string;
  chunkMethod: string;
  parserConfig: unknown;
  visibility: KnowledgeBaseVisibility;
  createdAt: Date;
  updatedAt: Date;
  ragflowDatasetId?: string;
  _count?: { documents: number };
  owner?: { id: string; username: string };
  members?: Array<{ userId: string; role: KnowledgeBaseRole }>;
};

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
  ) {}

  /** Owner always has full control. */
  isOwner(userId: string, kb: { ownerUserId: string }) {
    return kb.ownerUserId === userId;
  }

  /** Admin actions: delete KB, change visibility, manage members. */
  canAdmin(userId: string, kb: { ownerUserId: string }) {
    return this.isOwner(userId, kb);
  }

  /**
   * Mutate documents (upload/parse/delete).
   * Owner or shared editor (member.role === editor).
   */
  canEditContent(
    userId: string,
    kb: {
      ownerUserId: string;
      members?: Array<{ userId: string; role: KnowledgeBaseRole }>;
    },
  ) {
    if (this.isOwner(userId, kb)) return true;
    return (kb.members || []).some(
      (m) => m.userId === userId && m.role === KnowledgeBaseRole.editor,
    );
  }

  /**
   * List/open/preview/chat retrieve.
   * Owner, public, or any membership row.
   */
  canRead(
    userId: string,
    kb: {
      ownerUserId: string;
      visibility: KnowledgeBaseVisibility;
      members?: Array<{ userId: string; role: KnowledgeBaseRole }>;
    },
  ) {
    if (this.isOwner(userId, kb)) return true;
    if (kb.visibility === KnowledgeBaseVisibility.public) return true;
    return (kb.members || []).some((m) => m.userId === userId);
  }

  private myRole(
    userId: string,
    kb: {
      ownerUserId: string;
      visibility: KnowledgeBaseVisibility;
      members?: Array<{ userId: string; role: KnowledgeBaseRole }>;
    },
  ): 'owner' | 'viewer' | 'editor' | null {
    if (this.isOwner(userId, kb)) return 'owner';
    const member = (kb.members || []).find((m) => m.userId === userId);
    if (member) return member.role === KnowledgeBaseRole.editor ? 'editor' : 'viewer';
    if (kb.visibility === KnowledgeBaseVisibility.public) return 'viewer';
    return null;
  }

  private serialize(userId: string, kb: KbWithAccess) {
    const isOwner = this.isOwner(userId, kb);
    return {
      id: kb.id,
      name: kb.name,
      description: kb.description,
      chunkMethod: kb.chunkMethod,
      parserConfig: kb.parserConfig,
      visibility: kb.visibility,
      ownerUserId: kb.ownerUserId,
      ownerUsername: kb.owner?.username,
      isOwner,
      myRole: this.myRole(userId, kb),
      documentCount: kb._count?.documents ?? undefined,
      createdAt: kb.createdAt.toISOString(),
      updatedAt: kb.updatedAt.toISOString(),
    };
  }

  private readableWhere(userId: string): Prisma.KnowledgeBaseWhereInput {
    return {
      OR: [
        { ownerUserId: userId },
        { visibility: KnowledgeBaseVisibility.public },
        { members: { some: { userId } } },
      ],
    };
  }

  private accessInclude = {
    _count: { select: { documents: true } },
    owner: { select: { id: true, username: true } },
    members: { select: { userId: true, role: true } },
  } as const;

  async list(userId: string) {
    const items = await this.prisma.knowledgeBase.findMany({
      where: this.readableWhere(userId),
      orderBy: { updatedAt: 'desc' },
      include: this.accessInclude,
    });
    return items.map((kb) => this.serialize(userId, kb));
  }

  /** Load KB if readable; throws notFound otherwise. */
  async getReadable(userId: string, id: string) {
    const kb = await this.prisma.knowledgeBase.findFirst({
      where: { id, ...this.readableWhere(userId) },
      include: this.accessInclude,
    });
    if (!kb) throw notFound('knowledge base not found');
    return kb;
  }

  /** Load KB if user can edit content; throws notFound/forbidden. */
  async getEditable(userId: string, id: string) {
    const kb = await this.prisma.knowledgeBase.findFirst({
      where: { id },
      include: this.accessInclude,
    });
    if (!kb || !this.canRead(userId, kb)) throw notFound('knowledge base not found');
    if (!this.canEditContent(userId, kb)) {
      throw forbidden('you do not have permission to modify this knowledge base');
    }
    return kb;
  }

  /** Load KB if owner/admin; throws notFound. */
  async getOwned(userId: string, id: string) {
    const kb = await this.prisma.knowledgeBase.findFirst({
      where: { id, ownerUserId: userId },
      include: this.accessInclude,
    });
    if (!kb) throw notFound('knowledge base not found');
    return kb;
  }

  async get(userId: string, id: string) {
    const kb = await this.getReadable(userId, id);
    return this.serialize(userId, kb);
  }

  async create(userId: string, dto: CreateKnowledgeBaseDto) {
    const name = dto.name.trim();
    if (!name) throw badRequest('name is required');

    const visibility: KnowledgeBaseVisibility =
      dto.visibility === 'public'
        ? KnowledgeBaseVisibility.public
        : KnowledgeBaseVisibility.private;

    const exists = await this.prisma.knowledgeBase.findFirst({
      where: { ownerUserId: userId, name },
    });
    if (exists) throw badRequest('knowledge base name already exists');

    // RAGFlow dataset names should be unique globally; prefix with short user id
    const rfName = `${name}__${userId.slice(0, 8)}`;
    const dataset = await this.ragflow.createDataset({
      name: rfName,
      description: dto.description || '',
      chunkMethod: dto.chunkMethod || 'naive',
      parserConfig: dto.parserConfig,
    });

    const kb = await this.prisma.knowledgeBase.create({
      data: {
        ownerUserId: userId,
        ragflowDatasetId: dataset.id,
        name,
        description: dto.description?.trim() || '',
        chunkMethod: dto.chunkMethod || 'naive',
        parserConfig: (dto.parserConfig || {}) as Prisma.InputJsonValue,
        visibility,
      },
      include: this.accessInclude,
    });
    return this.serialize(userId, kb);
  }

  async update(userId: string, id: string, dto: UpdateKnowledgeBaseDto) {
    const kb = await this.getOwned(userId, id);

    const data: Prisma.KnowledgeBaseUpdateInput = {};
    if (dto.visibility === 'public' || dto.visibility === 'private') {
      data.visibility =
        dto.visibility === 'public'
          ? KnowledgeBaseVisibility.public
          : KnowledgeBaseVisibility.private;
    }
    if (Object.keys(data).length === 0) {
      throw badRequest('no valid fields to update');
    }

    const updated = await this.prisma.knowledgeBase.update({
      where: { id: kb.id },
      data,
      include: this.accessInclude,
    });
    return this.serialize(userId, updated);
  }

  async remove(userId: string, id: string) {
    const kb = await this.getOwned(userId, id);
    try {
      await this.ragflow.deleteDatasets([kb.ragflowDatasetId]);
    } catch {
      // still remove local ownership so user is not stuck
    }
    await this.prisma.knowledgeBase.delete({ where: { id: kb.id } });
    return { ok: true };
  }

  private serializeMember(m: {
    id: string;
    userId: string;
    role: KnowledgeBaseRole;
    createdAt: Date;
    updatedAt: Date;
    user: { username: string };
  }) {
    return {
      id: m.id,
      userId: m.userId,
      username: m.user.username,
      role: m.role === KnowledgeBaseRole.editor ? ('editor' as const) : ('viewer' as const),
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    };
  }

  private parseMemberRole(role?: string): KnowledgeBaseRole {
    if (role === 'editor') return KnowledgeBaseRole.editor;
    return KnowledgeBaseRole.viewer;
  }

  /** Owner only: list people this KB is shared with. */
  async listMembers(ownerUserId: string, knowledgeBaseId: string) {
    await this.getOwned(ownerUserId, knowledgeBaseId);
    const members = await this.prisma.knowledgeBaseMember.findMany({
      where: { knowledgeBaseId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { username: true } } },
    });
    return { items: members.map((m) => this.serializeMember(m)) };
  }

  /**
   * Owner only: active users that can still be shared with
   * (excludes owner, disabled accounts, and existing members).
   */
  async listShareCandidates(ownerUserId: string, knowledgeBaseId: string) {
    const kb = await this.getOwned(ownerUserId, knowledgeBaseId);
    const existing = await this.prisma.knowledgeBaseMember.findMany({
      where: { knowledgeBaseId: kb.id },
      select: { userId: true },
    });
    const excludeIds = [kb.ownerUserId, ...existing.map((m) => m.userId)];

    const users = await this.prisma.user.findMany({
      where: {
        disabledAt: null,
        id: { notIn: excludeIds },
      },
      select: { id: true, username: true },
      orderBy: { username: 'asc' },
      take: 500,
    });

    return {
      items: users.map((u) => ({ id: u.id, username: u.username })),
    };
  }

  /** Owner only: share with a user by username. Upserts role if already a member. */
  async addMember(
    ownerUserId: string,
    knowledgeBaseId: string,
    dto: AddKnowledgeBaseMemberDto,
  ) {
    const kb = await this.getOwned(ownerUserId, knowledgeBaseId);
    const username = (dto.username || '').trim();
    if (!username) throw badRequest('username is required');

    const target = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
    });
    if (!target) throw notFound('user not found');
    if (target.disabledAt) throw badRequest('user account is disabled');
    if (target.id === kb.ownerUserId) {
      throw badRequest('cannot share with the owner');
    }

    const role = this.parseMemberRole(dto.role);
    const member = await this.prisma.knowledgeBaseMember.upsert({
      where: {
        knowledgeBaseId_userId: {
          knowledgeBaseId: kb.id,
          userId: target.id,
        },
      },
      create: {
        knowledgeBaseId: kb.id,
        userId: target.id,
        role,
      },
      update: { role },
      include: { user: { select: { username: true } } },
    });
    return this.serializeMember(member);
  }

  /** Owner only: change member role. */
  async updateMember(
    ownerUserId: string,
    knowledgeBaseId: string,
    memberUserId: string,
    dto: UpdateKnowledgeBaseMemberDto,
  ) {
    await this.getOwned(ownerUserId, knowledgeBaseId);
    const existing = await this.prisma.knowledgeBaseMember.findFirst({
      where: { knowledgeBaseId, userId: memberUserId },
    });
    if (!existing) throw notFound('member not found');

    const role = this.parseMemberRole(dto.role);
    const member = await this.prisma.knowledgeBaseMember.update({
      where: { id: existing.id },
      data: { role },
      include: { user: { select: { username: true } } },
    });
    return this.serializeMember(member);
  }

  /** Owner only: revoke share. */
  async removeMember(
    ownerUserId: string,
    knowledgeBaseId: string,
    memberUserId: string,
  ) {
    await this.getOwned(ownerUserId, knowledgeBaseId);
    const existing = await this.prisma.knowledgeBaseMember.findFirst({
      where: { knowledgeBaseId, userId: memberUserId },
    });
    if (!existing) throw notFound('member not found');
    await this.prisma.knowledgeBaseMember.delete({ where: { id: existing.id } });
    return { ok: true };
  }
}
