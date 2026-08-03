/**
 * Deterministic extraction of L1 profile fields from a user message.
 * Used to avoid LLM retyping typos (alexhong → alekhong).
 */

export type ExtractedProfilePatch = {
  displayName?: string;
  language?: string;
  responseStyle?: string;
  bio?: string;
};

/** Collapse whitespace; keep original casing for names. */
function cleanCapture(raw: string, max: number): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Extract display name from explicit user phrasing.
 * Returns the substring as typed by the user (no case fold / no "fixing").
 */
export function extractDisplayNameFromMessage(message: string): string | null {
  const text = (message || '').trim();
  if (!text) return null;

  const patterns: RegExp[] = [
    // English
    /\bshould\s+be\s+([^\n.!?,，。；;]+)/i,
    /\bmy\s+name\s+is\s+([^\n.!?,，。；;]+)/i,
    /\bcall\s+me\s+([^\n.!?,，。；;]+)/i,
    /\bname\s*(?:is|=|:)\s*([^\n.!?,，。；;]+)/i,
    /\bdisplay\s*name\s*(?:is|=|:)\s*([^\n.!?,，。；;]+)/i,
    // Chinese
    /叫我\s*([^\n.!?,，。；;\s]+)/,
    /以後叫我\s*([^\n.!?,，。；;\s]+)/,
    /以后叫我\s*([^\n.!?,，。；;\s]+)/,
    /名字[是為为]\s*([^\n.!?,，。；;]+)/,
    /稱呼我\s*([^\n.!?,，。；;\s]+)/,
    /称呼我\s*([^\n.!?,，。；;\s]+)/,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      // Prefer last token for "should be my name alexhong" style — take capture as-is
      let name = cleanCapture(m[1], 80);
      // Strip wrapping quotes
      name = name.replace(/^["'「『]|["'」』]$/g, '').trim();
      // Drop trailing polite fluff
      name = name.replace(/(?:please|謝謝|谢谢|喔|哦|吧)$/i, '').trim();
      if (name.length >= 1 && name.length <= 80) return name;
    }
  }
  return null;
}

/**
 * Prefer the exact spelling from the user message when the model is updating displayName.
 * If the message clearly states a name, always use that string instead of the model param.
 */
export function resolveDisplayNameForUpdate(
  userMessage: string,
  modelDisplayName: string | undefined,
): string | undefined {
  if (modelDisplayName === undefined) {
    // Model did not pass displayName — still apply if user clearly set a name
    const fromUser = extractDisplayNameFromMessage(userMessage);
    return fromUser ?? undefined;
  }
  const fromUser = extractDisplayNameFromMessage(userMessage);
  if (fromUser) return fromUser;
  return modelDisplayName;
}

export function extractLanguageFromMessage(message: string): string | null {
  const text = (message || '').trim();
  if (!text) return null;
  const patterns: RegExp[] = [
    /\b(?:default\s+)?language\s*(?:is|=|:|to)\s*([^\n.!?,，。；;]+)/i,
    /一律\s*(用)?\s*(繁體中文|简体中文|簡體中文|英文|中文|English|zh-Hant|zh-Hans|en)\b/i,
    /用\s*(繁體中文|简体中文|簡體中文|英文|English|zh-Hant|zh-Hans)\b/,
    /預設語言\s*[是為为:：]\s*([^\n.!?,，。；;]+)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const raw = (m[2] || m[1] || '').trim();
      if (raw) return cleanCapture(raw, 32);
    }
  }
  return null;
}
