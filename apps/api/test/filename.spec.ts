import { describe, expect, it } from 'vitest';
import {
  decodeMojibakeUtf8,
  fixMulterOriginalName,
} from '../src/common/filename';

/** Simulate what multer/busboy does to a UTF-8 filename. */
function asMulterOriginalName(utf8Name: string): string {
  return Buffer.from(utf8Name, 'utf8').toString('latin1');
}

describe('fixMulterOriginalName', () => {
  it('restores Chinese video filenames garbled by multer Latin-1 decoding', () => {
    const real =
      '2025-12-29 粤语洪灏（下）：2026年三大投资主线，必须配置这些板块有翻倍股机会.mp4';
    const garbled = asMulterOriginalName(real);
    expect(garbled).not.toBe(real);
    expect(garbled).toMatch(/ç|è|æ|å/);
    expect(fixMulterOriginalName(garbled)).toBe(real);
  });

  it('leaves pure ASCII unchanged', () => {
    expect(fixMulterOriginalName('meeting-001.mp4')).toBe('meeting-001.mp4');
  });

  it('is idempotent when name is already correct UTF-8 Chinese', () => {
    const real = '粤语会议.m4a';
    expect(fixMulterOriginalName(real)).toBe(real);
  });

  it('falls back for empty / missing', () => {
    expect(fixMulterOriginalName('')).toBe('upload.bin');
    expect(fixMulterOriginalName(null)).toBe('upload.bin');
    expect(fixMulterOriginalName(undefined)).toBe('upload.bin');
  });
});

describe('decodeMojibakeUtf8', () => {
  it('heals stored document display names', () => {
    const real = '粤语洪灏 2026投资主线.mp4';
    const stored = asMulterOriginalName(real);
    expect(decodeMojibakeUtf8(stored)).toBe(real);
  });

  it('does not invent CJK from unrelated binary-looking text', () => {
    // Valid Latin-1 accented text that is not UTF-8 mojibake of CJK
    const french = 'résumé.pdf';
    // "résumé" as real UTF-8 should stay (decode path returns same or better)
    expect(decodeMojibakeUtf8(french)).toBe(french);
  });
});
