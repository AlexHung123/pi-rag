import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { badRequest, notFound } from '../common/errors';
import { CreateKnowledgeBaseDto } from './knowledge.dto';

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
  ) {}

  private serialize(kb: {
    id: string;
    name: string;
    description: string;
    chunkMethod: string;
    parserConfig: unknown;
    createdAt: Date;
    updatedAt: Date;
    _count?: { documents: number };
  }) {
    return {
      id: kb.id,
      name: kb.name,
      description: kb.description,
      chunkMethod: kb.chunkMethod,
      parserConfig: kb.parserConfig,
      documentCount: kb._count?.documents ?? undefined,
      createdAt: kb.createdAt.toISOString(),
      updatedAt: kb.updatedAt.toISOString(),
    };
  }

  async list(userId: string) {
    const items = await this.prisma.knowledgeBase.findMany({
      where: { ownerUserId: userId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { documents: true } } },
    });
    return items.map((kb) => this.serialize(kb));
  }

  async getOwned(userId: string, id: string) {
    const kb = await this.prisma.knowledgeBase.findFirst({
      where: { id, ownerUserId: userId },
      include: { _count: { select: { documents: true } } },
    });
    if (!kb) throw notFound('knowledge base not found');
    return kb;
  }

  async get(userId: string, id: string) {
    const kb = await this.getOwned(userId, id);
    return this.serialize(kb);
  }

  async create(userId: string, dto: CreateKnowledgeBaseDto) {
    const name = dto.name.trim();
    if (!name) throw badRequest('name is required');

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
      },
      include: { _count: { select: { documents: true } } },
    });
    return this.serialize(kb);
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
}
