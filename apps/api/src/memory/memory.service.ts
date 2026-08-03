import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest, notFound } from '../common/errors';
import {
  buildMemoryPromptBlock,
  getMemoryPromptSettings,
  matchMemoryItemsByQuery,
  type MemoryItemForPrompt,
  type ProfileForPrompt,
} from './memory-prompt';
import type {
  CreateMemoryItemDto,
  UpdateMemoryItemDto,
  UpdateProfileDto,
} from './memory.dto';

const MAX_ACTIVE_ITEMS = 500;

@Injectable()
export class MemoryService {
  constructor(private readonly prisma: PrismaService) {}

  private settings() {
    return getMemoryPromptSettings();
  }

  async getOrCreateProfile(userId: string) {
    let row = await this.prisma.userProfile.findUnique({ where: { userId } });
    if (!row) {
      row = await this.prisma.userProfile.create({
        data: { userId },
      });
    }
    return this.serializeProfile(row);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.getOrCreateProfile(userId);
    const data: Prisma.UserProfileUpdateInput = {};
    if (dto.displayName !== undefined) {
      data.displayName =
        dto.displayName === null || dto.displayName === ''
          ? null
          : String(dto.displayName).slice(0, 80);
    }
    if (dto.language !== undefined) {
      data.language =
        dto.language === null || dto.language === ''
          ? null
          : String(dto.language).slice(0, 32);
    }
    if (dto.responseStyle !== undefined) {
      data.responseStyle =
        dto.responseStyle === null || dto.responseStyle === ''
          ? null
          : String(dto.responseStyle).slice(0, 200);
    }
    if (dto.bio !== undefined) data.bio = String(dto.bio).slice(0, 2000);
    if (dto.prefs !== undefined) {
      const raw = JSON.stringify(dto.prefs);
      if (raw.length > 4096) throw badRequest('prefs too large (max 4 KiB)');
      data.prefs = dto.prefs as Prisma.InputJsonValue;
    }
    const row = await this.prisma.userProfile.update({
      where: { userId },
      data,
    });
    return this.serializeProfile(row);
  }

  async listItems(
    userId: string,
    opts?: { status?: 'active' | 'archived' | 'all'; category?: string },
  ) {
    const where: Prisma.MemoryItemWhereInput = { userId };
    if (opts?.status && opts.status !== 'all') {
      where.status = opts.status;
    } else if (!opts?.status) {
      where.status = 'active';
    }
    if (opts?.category) {
      where.category = opts.category as Prisma.EnumMemoryCategoryFilter;
    }
    const rows = await this.prisma.memoryItem.findMany({
      where,
      orderBy: [
        { pinned: 'desc' },
        { importance: 'desc' },
        { updatedAt: 'desc' },
      ],
    });
    return rows.map((r) => this.serializeItem(r));
  }

  /** Admin / cross-user: profile + items for one user (must exist). */
  async getUserMemoryBundle(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, role: true, disabledAt: true },
    });
    if (!user) throw notFound('user not found');
    const profile = await this.getOrCreateProfile(userId);
    const items = await this.listItems(userId, { status: 'all' });
    return {
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        disabled: Boolean(user.disabledAt),
      },
      profile,
      items,
      counts: {
        total: items.length,
        active: items.filter((i) => i.status === 'active').length,
        pinned: items.filter((i) => i.pinned && i.status === 'active').length,
      },
    };
  }

  async createItem(userId: string, dto: CreateMemoryItemDto) {
    const content = dto.content.trim();
    if (!content) throw badRequest('content is required');

    const activeCount = await this.prisma.memoryItem.count({
      where: { userId, status: 'active' },
    });
    if (activeCount >= MAX_ACTIVE_ITEMS) {
      throw badRequest(`active memory limit reached (${MAX_ACTIVE_ITEMS})`);
    }

    const pinned = Boolean(dto.pinned);
    if (pinned) await this.assertPinBudget(userId, null);

    const row = await this.prisma.memoryItem.create({
      data: {
        userId,
        content: content.slice(0, 500),
        category: dto.category ?? 'other',
        pinned,
        importance: dto.importance ?? 3,
        source: 'manual',
        status: 'active',
      },
    });
    return this.serializeItem(row);
  }

  async updateItem(userId: string, id: string, dto: UpdateMemoryItemDto) {
    const existing = await this.prisma.memoryItem.findFirst({
      where: { id, userId },
    });
    if (!existing) throw notFound('memory item not found');

    const willPin =
      dto.pinned !== undefined ? Boolean(dto.pinned) : existing.pinned;
    const willStatus = dto.status ?? existing.status;
    if (willPin && willStatus === 'active') {
      await this.assertPinBudget(userId, id);
    }

    const data: Prisma.MemoryItemUpdateInput = {};
    if (dto.content !== undefined) {
      const c = dto.content.trim();
      if (!c) throw badRequest('content is required');
      data.content = c.slice(0, 500);
    }
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.pinned !== undefined) data.pinned = dto.pinned;
    if (dto.importance !== undefined) data.importance = dto.importance;
    if (dto.status !== undefined) data.status = dto.status;

    const row = await this.prisma.memoryItem.update({
      where: { id },
      data,
    });
    return this.serializeItem(row);
  }

  async deleteItem(userId: string, id: string) {
    const existing = await this.prisma.memoryItem.findFirst({
      where: { id, userId },
    });
    if (!existing) throw notFound('memory item not found');
    await this.prisma.memoryItem.delete({ where: { id } });
    return { ok: true as const };
  }

  /**
   * Agent/tool helper: forget by exact id or content substring.
   * - 0 matches → not found message
   * - 1 match → hard-delete
   * - many matches → return candidates (no delete)
   */
  async forgetByQuery(
    userId: string,
    query: string,
  ): Promise<
    | { ok: true; deleted: ReturnType<MemoryService['serializeItem']> }
    | {
        ok: false;
        reason: 'not_found' | 'ambiguous' | 'empty_query';
        message: string;
        candidates?: ReturnType<MemoryService['serializeItem']>[];
      }
  > {
    const q = (query || '').trim();
    if (!q) {
      return {
        ok: false,
        reason: 'empty_query',
        message: 'Forget query is empty.',
      };
    }
    const active = await this.listItems(userId, { status: 'active' });
    const matches = matchMemoryItemsByQuery(active, q);
    if (matches.length === 0) {
      return {
        ok: false,
        reason: 'not_found',
        message: `No active memory matched: ${q}`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        message: `Multiple memories matched (${matches.length}). Use a more specific phrase or pass the memory id.`,
        candidates: matches.slice(0, 10),
      };
    }
    const target = matches[0]!;
    await this.deleteItem(userId, target.id);
    return { ok: true, deleted: target };
  }

  /**
   * Load profile + active items and format injection prefix for one chat turn.
   */
  async buildPromptPrefix(userId: string): Promise<string> {
    const settings = this.settings();
    if (!settings.enabled) return '';

    const profile = await this.prisma.userProfile.findUnique({
      where: { userId },
    });
    const items = await this.prisma.memoryItem.findMany({
      where: { userId, status: 'active' },
    });

    const profileFor: ProfileForPrompt = profile
      ? {
          displayName: profile.displayName,
          language: profile.language,
          responseStyle: profile.responseStyle,
          bio: profile.bio,
          prefs:
            profile.prefs &&
            typeof profile.prefs === 'object' &&
            !Array.isArray(profile.prefs)
              ? (profile.prefs as Record<string, unknown>)
              : {},
        }
      : {
          displayName: null,
          language: null,
          responseStyle: null,
          bio: '',
          prefs: {},
        };

    const itemsFor: MemoryItemForPrompt[] = items.map((r) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      pinned: r.pinned,
      importance: r.importance,
      updatedAt: r.updatedAt,
    }));

    return buildMemoryPromptBlock({
      profile: profileFor,
      items: itemsFor,
      settings,
    });
  }

  private async assertPinBudget(userId: string, excludeId: string | null) {
    const maxPinned = this.settings().maxPinned;
    const count = await this.prisma.memoryItem.count({
      where: {
        userId,
        status: 'active',
        pinned: true,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    if (count >= maxPinned) {
      throw badRequest(`pinned memory limit reached (${maxPinned})`);
    }
  }

  private serializeProfile(row: {
    userId: string;
    displayName: string | null;
    language: string | null;
    responseStyle: string | null;
    bio: string;
    prefs: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      userId: row.userId,
      displayName: row.displayName,
      language: row.language,
      responseStyle: row.responseStyle,
      bio: row.bio,
      prefs:
        row.prefs && typeof row.prefs === 'object' && !Array.isArray(row.prefs)
          ? row.prefs
          : {},
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private serializeItem(row: {
    id: string;
    userId: string;
    content: string;
    category: string;
    pinned: boolean;
    importance: number;
    source: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      userId: row.userId,
      content: row.content,
      category: row.category,
      pinned: row.pinned,
      importance: row.importance,
      source: row.source,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
