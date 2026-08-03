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

/**
 * Match active memory items by id or case-insensitive content substring.
 * Used by memory_forget tool.
 */
export function matchMemoryItemsByQuery<
  T extends { id: string; content: string },
>(items: T[], query: string): T[] {
  const q = (query || '').trim();
  if (!q) return [];
  // Exact id match first
  const byId = items.filter((it) => it.id === q);
  if (byId.length) return byId;
  const lower = q.toLowerCase();
  return items.filter((it) => it.content.toLowerCase().includes(lower));
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
  if (p.displayName?.trim()) {
    // Emphasize verbatim use — models often retype names with typos.
    lines.push(
      `- Name (verbatim, do not alter spelling): ${p.displayName.trim()}`,
    );
  }
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
  const tags = it.pinned ? `[${it.category}][pinned]` : `[${it.category}]`;
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
      'Rules: Prefer the current user message if it conflicts. Do not invent memories not listed. ' +
        'If Profile Name is set, answer name questions with that exact string (character-for-character).',
    );
    return parts.join('\n') + '\n\n';
  };

  let block = build(selected);
  while (selected.length > 0 && estimateTokens(block) > settings.maxTokens) {
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
