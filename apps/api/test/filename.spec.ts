import { describe, expect, it } from 'vitest';
import {
  contentDispositionHeader,
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

describe('contentDispositionHeader', () => {
  it('uses ASCII fallback + RFC 5987 for Chinese names', () => {
    const h = contentDispositionHeader('政策文件.pdf', 'inline');
    expect(h.startsWith('inline; filename=')).toBe(true);
    expect(h).toContain("filename*=UTF-8''");
    expect(h).toContain(encodeURIComponent('政策文件.pdf'));
    // ASCII filename= part must not contain raw CJK
    const asciiPart = h.match(/filename="([^"]*)"/)?.[1] || '';
    expect(asciiPart).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('keeps pure ASCII filenames readable', () => {
    const h = contentDispositionHeader('report v1.pdf', 'attachment');
    expect(h).toBe(
      'attachment; filename="report v1.pdf"; filename*=UTF-8\'\'report%20v1.pdf',
    );
  });

  it('is accepted by Node setHeader (no throw)', () => {
    const http = require('http') as typeof import('http');
    const h = contentDispositionHeader('測試 檔案.pptx', 'inline');
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Disposition', h);
      res.end('ok');
    });
    return new Promise<void>((resolve, reject) => {
      server.listen(0, async () => {
        try {
          const port = (server.address() as { port: number }).port;
          const r = await fetch(`http://127.0.0.1:${port}`);
          expect(r.status).toBe(200);
          expect(await r.text()).toBe('ok');
          resolve();
        } catch (e) {
          reject(e);
        } finally {
          server.close();
        }
      });
    });
  });
});
