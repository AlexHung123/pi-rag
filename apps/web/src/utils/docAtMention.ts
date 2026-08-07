/**
 * @ document autocomplete helpers (pi-web ChatInput style, scoped to KB docs).
 */

export type AtQueryMatch = {
  /** Index of the "@" character in the text */
  start: number;
  /** Text typed after the "@" (quotes stripped); may be empty */
  query: string;
  quoted: boolean;
};

/**
 * Detect an @ token immediately before the cursor.
 * @ must be at start or after whitespace (emails like foo@bar never trigger).
 */
export function extractAtQuery(textBeforeCursor: string): AtQueryMatch | null {
  const quoted = /(?:^|\s)@"([^"\n]*)$/.exec(textBeforeCursor);
  if (quoted) {
    return {
      start: textBeforeCursor.length - (quoted[1].length + 2),
      query: quoted[1],
      quoted: true,
    };
  }
  const plain = /(?:^|\s)@([^\s"]*)$/.exec(textBeforeCursor);
  if (plain) {
    return {
      start: textBeforeCursor.length - (plain[1].length + 1),
      query: plain[1],
      quoted: false,
    };
  }
  return null;
}

/** Closed @mention for a document name (quotes if spaces/special chars). */
export function buildDocMentionText(name: string): string {
  const clean = name.replace(/"/g, '').trim();
  if (!clean) return '';
  if (/[\s@]/.test(clean)) return `@"${clean}" `;
  return `@${clean} `;
}

export type DocAtCandidate = {
  id: string;
  name: string;
  kbId: string;
};

/** Rank / filter document candidates by basename query (substring, case-insensitive). */
export function filterDocAtCandidates(
  docs: DocAtCandidate[],
  query: string,
  limit = 50,
): DocAtCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return docs.slice(0, limit);
  const scored = docs
    .map((d) => {
      const name = d.name.toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.includes(q)) score = 50;
      else return null;
      return { d, score };
    })
    .filter((x): x is { d: DocAtCandidate; score: number } => x != null)
    .sort(
      (a, b) =>
        b.score - a.score || a.d.name.localeCompare(b.d.name, undefined, { sensitivity: 'base' }),
    );
  return scored.slice(0, limit).map((x) => x.d);
}
