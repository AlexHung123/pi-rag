/**
 * Multer/busboy historically decodes multipart Content-Disposition filenames
 * as Latin-1. Browsers send UTF-8 (including Chinese), so `file.originalname`
 * often arrives as mojibake (e.g. "ç²¤è¯­" instead of "粤语").
 *
 * Re-interpret the Latin-1 code units as UTF-8 bytes to restore the real name.
 * Safe for already-correct ASCII/UTF-8: pure ASCII is unchanged; if the
 * reinterpretation is invalid UTF-8 we keep the original string.
 */
export function fixMulterOriginalName(name: string | undefined | null): string {
  const raw = (name ?? '').trim() || 'upload.bin';
  return decodeMojibakeUtf8(raw) || 'upload.bin';
}

/**
 * Best-effort heal for strings already stored as Latin-1 mojibake of UTF-8.
 * Returns the original when decoding is not an improvement.
 */
export function decodeMojibakeUtf8(value: string): string {
  if (!value) return value;
  // Pure ASCII needs no fix
  if (!/[^\x00-\x7F]/.test(value)) return value;

  let decoded: string;
  try {
    decoded = Buffer.from(value, 'latin1').toString('utf8');
  } catch {
    return value;
  }

  // Invalid UTF-8 sequences become U+FFFD — keep original
  if (decoded.includes('\uFFFD')) return value;
  if (decoded === value) return value;

  // Prefer decoded when it clearly recovers CJK / non-Latin scripts from
  // typical Western European mojibake characters.
  const cjkOrWide = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
  const mojibakeLatin =
    /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/;

  if (cjkOrWide.test(decoded) && !cjkOrWide.test(value)) {
    return decoded;
  }
  if (mojibakeLatin.test(value) && !mojibakeLatin.test(decoded)) {
    // e.g. "Ã©" → "é" for French filenames
    return decoded;
  }

  return value;
}

/**
 * Build a Content-Disposition value that Node's HTTP stack will accept.
 * Non-ASCII (e.g. Chinese) in `filename="..."` throws:
 *   Invalid character in header content ["Content-Disposition"]
 * which can abort the response and surface as browser "Failed to fetch".
 *
 * Uses RFC 5987 `filename*=UTF-8''...` for the real name and a pure-ASCII
 * `filename=` fallback for older clients.
 */
export function contentDispositionHeader(
  filename: string,
  type: 'inline' | 'attachment' = 'inline',
): string {
  const raw = (filename || 'download.bin').replace(/[\r\n]/g, '').trim() || 'download.bin';
  // ASCII fallback: strip non-latin1-safe header chars
  const ascii =
    raw
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '_')
      .replace(/\s+/g, ' ')
      .trim() || 'download.bin';
  const encoded = encodeURIComponent(raw).replace(/['()]/g, escape);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
