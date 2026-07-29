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
