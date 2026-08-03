# Personal Memory (L1/L2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cross-conversation user Profile + editable MemoryItems in Postgres, with budgeted prompt injection into each chat turn and a Settings UI for CRUD.

**Architecture:** Pure selection/format helpers (`memory-prompt.ts`) + Nest `MemoryModule` (Prisma CRUD + HTTP `/api/me/...`) + inject memory block as a **user-prompt prefix** on each agent turn (same pattern as selected-KB prefix; survives pool reuse and Settings updates). Web: new sidebar workspace + `MemoryPanel`.

**Tech Stack:** NestJS, Prisma/Postgres, vitest, React/Vite.

**Spec:** `docs/superpowers/specs/2026-08-03-personal-memory-design.md`

---

## File map

| Path | Responsibility |
|------|----------------|
| `apps/api/src/memory/memory-prompt.ts` | Env settings, token estimate, select items, format block (pure, unit-tested) |
| `apps/api/src/memory/memory.service.ts` | Profile upsert, MemoryItem CRUD, pin/active caps, load for injection |
| `apps/api/src/memory/memory.controller.ts` | `GET/PUT /api/me/profile`, CRUD `/api/me/memories` |
| `apps/api/src/memory/memory.dto.ts` | class-validator DTOs |
| `apps/api/src/memory/memory.module.ts` | Nest module; exports `MemoryService` |
| `apps/api/prisma/schema.prisma` | `UserProfile`, `MemoryItem` + enums |
| `apps/api/prisma/migrations/...` | Migration SQL |
| `apps/api/src/agent/agent.service.ts` | Prepend memory block to `promptText` before KB prefix |
| `apps/api/src/agent/agent.module.ts` | Import `MemoryModule` |
| `apps/api/src/app.module.ts` | Import `MemoryModule` |
| `apps/api/test/memory-prompt.spec.ts` | Selection + format unit tests |
| `apps/web/src/services/api.ts` | `memoryApi` client |
| `apps/web/src/components/MemoryPanel.tsx` | Profile form + item list CRUD |
| `apps/web/src/components/AppSidebar.tsx` | Workspace `memory` + nav item |
| `apps/web/src/App.tsx` | Render `MemoryPanel` when workspace is `memory` |
| `apps/web/src/styles/index.css` | Minimal panel styles (reuse existing form patterns) |
| `.env.example` | Memory env vars |

**Out of plan (P1+):** `memory_save` / `memory_forget` tools, auto-extract, L3.

---

### Task 1: Pure prompt builder + unit tests (TDD)

**Files:**
- Create: `apps/api/src/memory/memory-prompt.ts`
- Create: `apps/api/test/memory-prompt.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/test/memory-prompt.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildMemoryPromptBlock,
  estimateTokens,
  getMemoryPromptSettings,
  selectMemoryItems,
  type MemoryItemForPrompt,
  type ProfileForPrompt,
} from '../src/memory/memory-prompt';

function item(
  partial: Partial<MemoryItemForPrompt> & { id: string; content: string },
): MemoryItemForPrompt {
  return {
    category: 'other',
    pinned: false,
    importance: 3,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...partial,
  };
}

describe('getMemoryPromptSettings', () => {
  it('defaults enabled with locked budgets', () => {
    const s = getMemoryPromptSettings({});
    expect(s.enabled).toBe(true);
    expect(s.maxTokens).toBe(2000);
    expect(s.maxItems).toBe(15);
    expect(s.maxPinned).toBe(15);
  });

  it('can disable via env', () => {
    expect(
      getMemoryPromptSettings({ MEMORY_INJECTION_ENABLED: 'false' }).enabled,
    ).toBe(false);
  });
});

describe('selectMemoryItems', () => {
  it('orders pinned first then importance then recency', () => {
    const items = [
      item({
        id: 'a',
        content: 'low',
        importance: 1,
        updatedAt: new Date('2026-06-01'),
      }),
      item({
        id: 'b',
        content: 'pin',
        pinned: true,
        importance: 1,
        updatedAt: new Date('2026-01-01'),
      }),
      item({
        id: 'c',
        content: 'high',
        importance: 5,
        updatedAt: new Date('2026-03-01'),
      }),
      item({
        id: 'd',
        content: 'mid-newer',
        importance: 5,
        updatedAt: new Date('2026-05-01'),
      }),
    ];
    const selected = selectMemoryItems(items, 3);
    expect(selected.map((x) => x.id)).toEqual(['b', 'd', 'c']);
  });

  it('respects maxItems', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      item({ id: `i${i}`, content: `c${i}`, importance: i }),
    );
    expect(selectMemoryItems(items, 15)).toHaveLength(15);
  });
});

describe('buildMemoryPromptBlock', () => {
  const emptyProfile: ProfileForPrompt = {
    displayName: null,
    language: null,
    responseStyle: null,
    bio: '',
    prefs: {},
  };

  it('returns empty string when disabled', () => {
    const block = buildMemoryPromptBlock({
      profile: {
        ...emptyProfile,
        displayName: 'Ming',
      },
      items: [item({ id: '1', content: 'fact' })],
      settings: { enabled: false, maxTokens: 2000, maxItems: 15, maxPinned: 15 },
    });
    expect(block).toBe('');
  });

  it('returns empty when profile empty and no items', () => {
    const block = buildMemoryPromptBlock({
      profile: emptyProfile,
      items: [],
      settings: { enabled: true, maxTokens: 2000, maxItems: 15, maxPinned: 15 },
    });
    expect(block).toBe('');
  });

  it('includes profile fields and memory lines', () => {
    const block = buildMemoryPromptBlock({
      profile: {
        displayName: '阿明',
        language: 'zh-Hant',
        responseStyle: 'short',
        bio: 'CSB KB',
        prefs: { noEmoji: true },
      },
      items: [
        item({
          id: '1',
          content: 'Use markdown tables',
          category: 'preference',
          pinned: true,
        }),
      ],
      settings: { enabled: true, maxTokens: 2000, maxItems: 15, maxPinned: 15 },
    });
    expect(block).toContain('[User profile & memory');
    expect(block).toContain('阿明');
    expect(block).toContain('zh-Hant');
    expect(block).toContain('Use markdown tables');
    expect(block).toContain('[preference][pinned]');
  });

  it('drops lowest-priority items to stay under token budget', () => {
    // ~800 tokens each via chars/4
    const long = 'x'.repeat(3200);
    const items = [
      item({ id: 'pin', content: long, pinned: true, importance: 5 }),
      item({ id: 'a', content: long, importance: 4 }),
      item({ id: 'b', content: long, importance: 1 }),
    ];
    const block = buildMemoryPromptBlock({
      profile: emptyProfile,
      items,
      settings: { enabled: true, maxTokens: 1000, maxItems: 15, maxPinned: 15 },
    });
    // Should keep higher-priority content first; budget forces truncation of tail
    expect(estimateTokens(block)).toBeLessThanOrEqual(1000);
    expect(block).toContain('pin'); // pinned content marker via id only if content same — check pinned line structure
    expect(block).toMatch(/\[other\]\[pinned\]/);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd apps/api && npx vitest run test/memory-prompt.spec.ts
```

Expected: cannot find module `../src/memory/memory-prompt`.

- [ ] **Step 3: Implement `memory-prompt.ts`**

Create `apps/api/src/memory/memory-prompt.ts`:

```typescript
/**
 * Pure helpers: budgeted personal-memory prompt block for agent turns.
 * Spec: docs/superpowers/specs/2026-08-03-personal-memory-design.md
 */

export type MemoryCategory = 'preference' | 'fact' | 'project' | 'other';

export type MemoryItemForPrompt = {
  id: string;
  content: string;
  category: MemoryCategory;
  pinned: boolean;
  importance: number;
  updatedAt: Date;
};

export type ProfileForPrompt = {
  displayName: string | null;
  language: string | null;
  responseStyle: string | null;
  bio: string;
  prefs: Record<string, unknown>;
};

export type MemoryPromptSettings = {
  enabled: boolean;
  maxTokens: number;
  maxItems: number;
  maxPinned: number;
};

function envPositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function getMemoryPromptSettings(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): MemoryPromptSettings {
  const enabledRaw = (env.MEMORY_INJECTION_ENABLED ?? 'true')
    .trim()
    .toLowerCase();
  return {
    enabled: enabledRaw !== 'false' && enabledRaw !== '0',
    maxTokens: envPositiveInt(env.MEMORY_PROMPT_MAX_TOKENS, 2000, 200, 50_000),
    maxItems: envPositiveInt(env.MEMORY_PROMPT_MAX_ITEMS, 15, 1, 100),
    maxPinned: envPositiveInt(env.MEMORY_MAX_PINNED, 15, 0, 100),
  };
}

/** Conservative chars/4 — same spirit as agent-compaction. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

export function selectMemoryItems(
  items: MemoryItemForPrompt[],
  maxItems: number,
): MemoryItemForPrompt[] {
  const sorted = [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.importance !== b.importance) return b.importance - a.importance;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
  return sorted.slice(0, Math.max(0, maxItems));
}

function profileHasContent(p: ProfileForPrompt): boolean {
  if (p.displayName?.trim()) return true;
  if (p.language?.trim()) return true;
  if (p.responseStyle?.trim()) return true;
  if (p.bio?.trim()) return true;
  if (p.prefs && Object.keys(p.prefs).length > 0) return true;
  return false;
}

function formatProfileSection(p: ProfileForPrompt): string {
  const lines: string[] = ['Profile:'];
  if (p.displayName?.trim()) lines.push(`- Name: ${p.displayName.trim()}`);
  if (p.language?.trim()) lines.push(`- Language: ${p.language.trim()}`);
  if (p.responseStyle?.trim())
    lines.push(`- Style: ${p.responseStyle.trim()}`);
  if (p.bio?.trim()) lines.push(`- Bio: ${p.bio.trim()}`);
  if (p.prefs && Object.keys(p.prefs).length > 0) {
    lines.push(`- Preferences: ${JSON.stringify(p.prefs)}`);
  }
  return lines.join('\n');
}

function formatItemLine(it: MemoryItemForPrompt): string {
  const tags = it.pinned
    ? `[${it.category}][pinned]`
    : `[${it.category}]`;
  return `- ${tags} ${it.content.trim()}`;
}

const HEADER =
  '[User profile & memory — durable facts about this user; honor unless the user overrides in this chat]';

/**
 * Build prompt prefix for one agent turn. Empty string if nothing to inject.
 */
export function buildMemoryPromptBlock(args: {
  profile: ProfileForPrompt;
  items: MemoryItemForPrompt[];
  settings?: MemoryPromptSettings;
}): string {
  const settings = args.settings ?? getMemoryPromptSettings();
  if (!settings.enabled) return '';

  let selected = selectMemoryItems(args.items, settings.maxItems);
  const hasProfile = profileHasContent(args.profile);
  if (!hasProfile && selected.length === 0) return '';

  const build = (items: MemoryItemForPrompt[]) => {
    const parts: string[] = [HEADER];
    if (hasProfile) parts.push(formatProfileSection(args.profile));
    if (items.length) {
      parts.push('Memories:');
      for (const it of items) parts.push(formatItemLine(it));
    }
    parts.push(
      'Rules: Prefer the current user message if it conflicts. Do not invent memories not listed.',
    );
    return parts.join('\n') + '\n\n';
  };

  let block = build(selected);
  while (
    selected.length > 0 &&
    estimateTokens(block) > settings.maxTokens
  ) {
    selected = selected.slice(0, -1);
    block = build(selected);
  }

  // Profile alone may still exceed budget — hard truncate text
  if (estimateTokens(block) > settings.maxTokens) {
    const maxChars = settings.maxTokens * 4;
    block = block.slice(0, maxChars);
    if (!block.endsWith('\n\n')) block = block.trimEnd() + '\n\n';
  }

  if (!hasProfile && selected.length === 0) return '';
  return block;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd apps/api && npx vitest run test/memory-prompt.spec.ts
```

Expected: all tests pass. If the token-budget test is flaky because all contents are identical long strings, assert only `estimateTokens(block) <= 1000` and that the block still starts with the header (adjust test if needed).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/memory/memory-prompt.ts apps/api/test/memory-prompt.spec.ts
git commit -m "feat(memory): pure budgeted prompt block builder"
```

---

### Task 2: Prisma schema + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: migration via Prisma CLI

- [ ] **Step 1: Add enums and models to schema**

In `apps/api/prisma/schema.prisma`, add enums (near other enums):

```prisma
enum MemoryCategory {
  preference
  fact
  project
  other
}

enum MemorySource {
  manual
  extracted
}

enum MemoryStatus {
  active
  archived
}
```

On `model User`, add relations:

```prisma
  profile      UserProfile?
  memoryItems  MemoryItem[]
```

Add models:

```prisma
model UserProfile {
  userId         String   @id @map("user_id") @db.Uuid
  displayName    String?  @map("display_name")
  language       String?
  responseStyle  String?  @map("response_style")
  bio            String   @default("")
  prefs          Json     @default("{}")
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("user_profiles")
}

model MemoryItem {
  id         String         @id @default(uuid()) @db.Uuid
  userId     String         @map("user_id") @db.Uuid
  content    String
  category   MemoryCategory @default(other)
  pinned     Boolean        @default(false)
  importance Int            @default(3)
  source     MemorySource   @default(manual)
  status     MemoryStatus   @default(active)
  createdAt  DateTime       @default(now()) @map("created_at")
  updatedAt  DateTime       @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, status, pinned, importance, updatedAt])
  @@index([userId, updatedAt])
  @@map("memory_items")
}
```

- [ ] **Step 2: Create and apply migration**

```bash
cd apps/api && npx prisma migrate dev --name personal_memory
```

Expected: migration applied; client generated.

If the environment cannot reach Postgres, still create the migration SQL with `prisma migrate dev` when DB is up; do not use `db push` for the committed path (project prefers migrate).

- [ ] **Step 3: Commit**

```bash
git add apps/api/prisma
git commit -m "feat(memory): prisma models for profile and memory items"
```

---

### Task 3: MemoryService + HTTP API

**Files:**
- Create: `apps/api/src/memory/memory.dto.ts`
- Create: `apps/api/src/memory/memory.service.ts`
- Create: `apps/api/src/memory/memory.controller.ts`
- Create: `apps/api/src/memory/memory.module.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: DTOs**

Create `apps/api/src/memory/memory.dto.ts`:

```typescript
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  language?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  responseStyle?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsObject()
  prefs?: Record<string, unknown>;
}

export class CreateMemoryItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  content!: string;

  @IsOptional()
  @IsIn(['preference', 'fact', 'project', 'other'])
  category?: 'preference' | 'fact' | 'project' | 'other';

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  importance?: number;
}

export class UpdateMemoryItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  content?: string;

  @IsOptional()
  @IsIn(['preference', 'fact', 'project', 'other'])
  category?: 'preference' | 'fact' | 'project' | 'other';

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  importance?: number;

  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';
}
```

- [ ] **Step 2: Service**

Create `apps/api/src/memory/memory.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest, notFound } from '../common/errors';
import {
  buildMemoryPromptBlock,
  getMemoryPromptSettings,
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
    opts?: { status?: 'active' | 'archived'; category?: string },
  ) {
    const status = opts?.status ?? 'active';
    const where: Prisma.MemoryItemWhereInput = { userId, status };
    if (opts?.category) {
      where.category = opts.category as Prisma.EnumMemoryCategoryFilter;
    }
    const rows = await this.prisma.memoryItem.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => this.serializeItem(r));
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
```

- [ ] **Step 3: Controller**

Create `apps/api/src/memory/memory.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthPrincipal } from '../auth/auth.types';
import { MemoryService } from './memory.service';
import {
  CreateMemoryItemDto,
  UpdateMemoryItemDto,
  UpdateProfileDto,
} from './memory.dto';

@Controller('api/me')
@UseGuards(AuthGuard)
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get('profile')
  getProfile(@CurrentUser() user: AuthPrincipal) {
    return this.memory.getOrCreateProfile(user.userId);
  }

  @Put('profile')
  putProfile(
    @CurrentUser() user: AuthPrincipal,
    @Body() body: UpdateProfileDto,
  ) {
    return this.memory.updateProfile(user.userId, body);
  }

  @Get('memories')
  listMemories(
    @CurrentUser() user: AuthPrincipal,
    @Query('status') status?: 'active' | 'archived',
    @Query('category') category?: string,
  ) {
    return this.memory
      .listItems(user.userId, { status, category })
      .then((items) => ({ items }));
  }

  @Post('memories')
  createMemory(
    @CurrentUser() user: AuthPrincipal,
    @Body() body: CreateMemoryItemDto,
  ) {
    return this.memory.createItem(user.userId, body);
  }

  @Patch('memories/:id')
  updateMemory(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body() body: UpdateMemoryItemDto,
  ) {
    return this.memory.updateItem(user.userId, id, body);
  }

  @Delete('memories/:id')
  deleteMemory(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
  ) {
    return this.memory.deleteItem(user.userId, id);
  }
}
```

- [ ] **Step 4: Module + app import**

Create `apps/api/src/memory/memory.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';

@Module({
  imports: [AuthModule],
  controllers: [MemoryController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
```

In `apps/api/src/app.module.ts`, import `MemoryModule` and add to `imports` array (after `AuthModule` is fine).

- [ ] **Step 5: Typecheck / smoke**

```bash
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
```

Expected: no errors related to memory module. Fix any Prisma client naming if generator uses different model names.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/memory apps/api/src/app.module.ts
git commit -m "feat(memory): profile and memory item API"
```

---

### Task 4: Inject memory into agent turns

**Files:**
- Modify: `apps/api/src/agent/agent.module.ts`
- Modify: `apps/api/src/agent/agent.service.ts`

- [ ] **Step 1: Import MemoryModule in AgentModule**

```typescript
import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentSessionPool } from './agent-session.pool';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [KnowledgeModule, MemoryModule],
  providers: [AgentSessionPool, AgentService],
  exports: [AgentService, AgentSessionPool],
})
export class AgentModule {}
```

- [ ] **Step 2: Inject MemoryService and prepend prefix**

In `agent.service.ts` constructor, inject `MemoryService`.

Before building `promptText` with KB prefix (around the block that starts `let promptText = userMessage`), add:

```typescript
const memoryPrefix = await this.memory.buildPromptPrefix(userId);
let promptText = userMessage;
if (memoryPrefix) {
  promptText = `${memoryPrefix}${promptText}`;
}
if (selectedKbIds.length) {
  // existing KB prefix logic — applies on top of memory+question
  // i.e. final: memoryPrefix + kbPrefix + userMessage
  ...
  promptText = `${memoryPrefix}${buildSelectedKbPromptPrefix(...)}${userMessage}`;
}
```

**Careful:** avoid double-applying `memoryPrefix`. Clean structure:

```typescript
const memoryPrefix = await this.memory.buildPromptPrefix(userId);
const selectedKbIds = (options.knowledgeBaseIds || []).filter(Boolean);
let promptText = userMessage;

if (selectedKbIds.length) {
  const owned = await this.knowledge.list(userId);
  const selected = owned
    .filter((k) => selectedKbIds.includes(k.id))
    .map((k) => ({ id: k.id, name: k.name }));
  if (selected.length) {
    const rewritten = await rewriteQueryForRetrieval(userMessage, history);
    // ... existing debug log ...
    promptText = `${buildSelectedKbPromptPrefix(selected, {
      rewriteQuery: rewritten.rewritten ? rewritten.rewriteQuery : undefined,
    })}${userMessage}`;
  }
}

if (memoryPrefix) {
  promptText = `${memoryPrefix}${promptText}`;
}
```

Order locked: **memory → KB prefix → user message**.

Do **not** change `systemPrompt: DOMAIN_SYSTEM_PROMPT` on agent create; dynamic memory belongs on the turn prefix so Settings edits apply without pool eviction.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/agent.module.ts apps/api/src/agent/agent.service.ts
git commit -m "feat(memory): inject personal memory into agent prompts"
```

---

### Task 5: Env documentation

**Files:**
- Modify: `.env.example`
- Modify: `apps/api/.env` only if local testing needs it (do not commit secrets)

- [ ] **Step 1: Append to `.env.example`**

```bash
# Personal memory (L1 profile + L2 items) prompt injection
MEMORY_INJECTION_ENABLED=true
MEMORY_PROMPT_MAX_TOKENS=2000
MEMORY_PROMPT_MAX_ITEMS=15
MEMORY_MAX_PINNED=15
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: env flags for personal memory injection"
```

---

### Task 6: Frontend API client + Memory panel

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Create: `apps/web/src/components/MemoryPanel.tsx`
- Modify: `apps/web/src/components/AppSidebar.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles/index.css` (only if needed for layout)

- [ ] **Step 1: API client**

In `apps/web/src/services/api.ts`, add types + `memoryApi`:

```typescript
export type UserProfile = {
  userId: string;
  displayName: string | null;
  language: string | null;
  responseStyle: string | null;
  bio: string;
  prefs: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MemoryItem = {
  id: string;
  userId: string;
  content: string;
  category: 'preference' | 'fact' | 'project' | 'other';
  pinned: boolean;
  importance: number;
  source: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export const memoryApi = {
  getProfile: () => apiFetch<UserProfile>('/api/me/profile'),
  updateProfile: (body: Partial<{
    displayName: string | null;
    language: string | null;
    responseStyle: string | null;
    bio: string;
    prefs: Record<string, unknown>;
  }>) =>
    apiFetch<UserProfile>('/api/me/profile', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  list: (params?: { status?: string; category?: string }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set('status', params.status);
    if (params?.category) q.set('category', params.category);
    const qs = q.toString();
    return apiFetch<{ items: MemoryItem[] }>(
      `/api/me/memories${qs ? `?${qs}` : ''}`,
    );
  },
  create: (body: {
    content: string;
    category?: string;
    pinned?: boolean;
    importance?: number;
  }) =>
    apiFetch<MemoryItem>('/api/me/memories', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (
    id: string,
    body: Partial<{
      content: string;
      category: string;
      pinned: boolean;
      importance: number;
      status: string;
    }>,
  ) =>
    apiFetch<MemoryItem>(`/api/me/memories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/me/memories/${id}`, {
      method: 'DELETE',
    }),
};
```

- [ ] **Step 2: MemoryPanel component**

Create `apps/web/src/components/MemoryPanel.tsx` — functional panel that:

1. On mount: `memoryApi.getProfile()` + `memoryApi.list()`.
2. Profile form fields: displayName, language, responseStyle, bio; Save → `updateProfile`.
3. New item: content textarea (max 500), category select, optional pin checkbox; Add → `create` + refresh list.
4. List: show content, category, pin toggle (`update` pinned), importance, Delete button, optional Archive (`status: 'archived'`).
5. Helper text (zh or en matching app):  
   `已保存的記憶不會全部進入每一輪對話；置頂與較重要的優先，每輪最多約 15 條。`
6. Error state as string under forms.

Keep styling with existing utility classes from `index.css` (look at KnowledgePanel / Login form patterns: `panel`, `field`, buttons). Prefer ~200–300 lines, no new design system.

Minimal structure sketch:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import {
  memoryApi,
  type MemoryItem,
  type UserProfile,
} from '../services/api';

export default function MemoryPanel() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // local form state for profile + new item ...

  const refresh = useCallback(async () => {
    const [p, list] = await Promise.all([
      memoryApi.getProfile(),
      memoryApi.list({ status: 'active' }),
    ]);
    setProfile(p);
    setItems(list.items || []);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e?.message || e)));
  }, [refresh]);

  // render profile form + list ...
}
```

Implement full JSX with controlled inputs; no need for a router.

- [ ] **Step 3: Sidebar workspace**

In `AppSidebar.tsx`:

- Extend `WorkspaceView` with `'memory'`.
- Add nav item after Knowledge, e.g. label `My Memory`, icon `Brain` or `UserCircle` from `lucide-react`.

```typescript
import { Brain, /* existing */ } from 'lucide-react';

export type WorkspaceView =
  | 'chat'
  | 'knowledge'
  | 'memory'
  | 'admin-datasets'
  // ...
```

In `workspaceItems`:

```typescript
{ id: 'chat', label: 'Chat', icon: <MessageSquare size={20} /> },
{ id: 'knowledge', label: 'My Knowledge Base', icon: <BookOpen size={20} /> },
{ id: 'memory', label: 'My Memory', icon: <Brain size={20} /> },
```

- [ ] **Step 4: App.tsx render**

Import `MemoryPanel`. Where other workspaces render (`workspace === 'knowledge'` etc.), add:

```tsx
{workspace === 'memory' && <MemoryPanel />}
```

Ensure chat UI is hidden when `workspace === 'memory'` the same way knowledge is (mirror existing conditional layout).

- [ ] **Step 5: Manual UI check**

```bash
# terminal 1
npm run dev:api
# terminal 2
npm run dev:web
```

- Open My Memory → save profile → add pinned item → open new chat → ask a question that should use the preference (no need for KB).
- Optional: inspect API `GET /api/me/profile` with session cookie.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/services/api.ts apps/web/src/components/MemoryPanel.tsx apps/web/src/components/AppSidebar.tsx apps/web/src/App.tsx apps/web/src/styles/index.css
git commit -m "feat(web): My Memory settings panel for profile and items"
```

---

### Task 7: Verification

- [ ] **Step 1: Unit tests**

```bash
cd apps/api && npx vitest run test/memory-prompt.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Full API unit suite (regression)**

```bash
cd apps/api && npm test
```

Expected: existing tests still pass.

- [ ] **Step 3: Build**

```bash
cd apps/api && npm run build
cd apps/web && npm run build
```

Expected: both succeed.

- [ ] **Step 4: Spec checklist (manual)**

| Criterion | How to verify |
|-----------|----------------|
| Profile honored in new chat | Set language/style; new conversation reflects it |
| New MemoryItem injects | Add item; next turn prompt includes it (or behavior changes) |
| Delete removes | Delete item; no longer influences answers |
| Isolation | (if two users) A’s memories never via B’s API |
| Budget | Create 20 items; injection still max 15 (unit test already covers selection) |

- [ ] **Step 5: Final commit only if verification fixed issues**

If only docs/tweaks:

```bash
git add -A
git status
git commit -m "fix(memory): verification follow-ups"
```

---

## Spec coverage (self-check)

| Spec requirement | Task |
|------------------|------|
| L1 Profile store + API | Task 2–3 |
| L2 MemoryItem store + API | Task 2–3 |
| Budgeted injection top-N + token cap | Task 1, 4 |
| Pin max | Task 3 `assertPinBudget` |
| Passive inject each turn | Task 4 |
| Settings UI CRUD | Task 6 |
| Env flags | Task 5 |
| Isolation / 404 | Task 3 ownership filters |
| No RAGFlow Memory / no tools / no auto-extract | Omitted by design |
| Success criteria | Task 7 |

## Type consistency

- `MemoryCategory`: `preference \| fact \| project \| other` in prompt types, Prisma enum, DTOs, web types.
- API base path: `/api/me/profile`, `/api/me/memories`.
- Settings: `MEMORY_INJECTION_ENABLED`, `MEMORY_PROMPT_MAX_TOKENS`, `MEMORY_PROMPT_MAX_ITEMS`, `MEMORY_MAX_PINNED`.
- Service method for agent: `MemoryService.buildPromptPrefix(userId)`.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-03-personal-memory.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — run tasks in this session with checkpoints  

Which approach?
