import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { badRequest } from '../common/errors';
import type { TranscriptSegment } from './transcript-format';

export type SttResult = {
  text: string;
  language?: string;
  duration?: number;
  segments: TranscriptSegment[];
};

@Injectable()
export class SttClient {
  private readonly logger = new Logger(SttClient.name);

  isMock(): boolean {
    return (process.env.STT_MOCK || '').toLowerCase() === 'true';
  }

  isConfigured(): boolean {
    if (this.isMock()) return true;
    return Boolean((process.env.STT_BASE_URL || '').trim());
  }

  /** Throw if audio upload is not allowed. */
  assertConfigured(): void {
    if (!this.isConfigured()) {
      throw badRequest(
        'STT is not configured. Set STT_BASE_URL (or STT_MOCK=true for development).',
      );
    }
  }

  async transcribeFile(
    filePath: string,
    opts?: { language?: string | null },
  ): Promise<SttResult> {
    this.assertConfigured();
    if (this.isMock()) {
      return this.mockResult(filePath, opts?.language);
    }

    const base = (process.env.STT_BASE_URL || '').replace(/\/$/, '');
    const apiKey = (process.env.STT_API_KEY || '').trim();
    const model = (process.env.STT_MODEL || '').trim();
    const timeoutMs = Number(process.env.STT_TIMEOUT_MS || 3_600_000);
    const language =
      (opts?.language || process.env.STT_DEFAULT_LANGUAGE || 'zh').trim() ||
      undefined;

    if (!fs.existsSync(filePath)) {
      throw new Error(`audio file not found: ${filePath}`);
    }

    const filename = path.basename(filePath);
    // Prefer file-backed Blob (Node 19.8+) to avoid an extra full-buffer copy when possible.
    let fileBlob: Blob;
    try {
      const openAsBlob = (fs as unknown as {
        openAsBlob?: (p: string) => Promise<Blob>;
      }).openAsBlob;
      if (typeof openAsBlob === 'function') {
        fileBlob = await openAsBlob(filePath);
      } else {
        fileBlob = new Blob([fs.readFileSync(filePath)], {
          type: 'application/octet-stream',
        });
      }
    } catch {
      fileBlob = new Blob([fs.readFileSync(filePath)], {
        type: 'application/octet-stream',
      });
    }
    const form = new FormData();
    form.append('file', fileBlob, filename);
    form.append('response_format', 'verbose_json');
    if (model) form.append('model', model);
    if (language) form.append('language', language);

    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/v1/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
      const textBody = await res.text();
      if (!res.ok) {
        throw new Error(
          `STT HTTP ${res.status}: ${textBody.slice(0, 500) || res.statusText}`,
        );
      }
      return this.normalizeResponse(textBody, language);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`STT request timed out after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  normalizeResponse(body: string, fallbackLanguage?: string): SttResult {
    const trimmed = (body || '').trim();
    if (!trimmed) {
      return { text: '', language: fallbackLanguage, segments: [] };
    }

    // Plain text fallback
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return {
        text: trimmed,
        language: fallbackLanguage,
        segments: [{ start: 0, end: 0, text: trimmed }],
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return {
        text: trimmed,
        language: fallbackLanguage,
        segments: [{ start: 0, end: 0, text: trimmed }],
      };
    }

    const obj = json as Record<string, unknown>;
    const text =
      typeof obj.text === 'string'
        ? obj.text
        : typeof obj.transcript === 'string'
          ? obj.transcript
          : '';
    const language =
      (typeof obj.language === 'string' ? obj.language : undefined) ||
      fallbackLanguage;
    const duration =
      typeof obj.duration === 'number'
        ? obj.duration
        : typeof obj.duration_seconds === 'number'
          ? obj.duration_seconds
          : undefined;

    const rawSegs = Array.isArray(obj.segments) ? obj.segments : [];
    const segments: TranscriptSegment[] = [];
    for (const s of rawSegs) {
      if (!s || typeof s !== 'object') continue;
      const seg = s as Record<string, unknown>;
      const start =
        typeof seg.start === 'number'
          ? seg.start
          : typeof seg.start_time === 'number'
            ? seg.start_time
            : 0;
      const end =
        typeof seg.end === 'number'
          ? seg.end
          : typeof seg.end_time === 'number'
            ? seg.end_time
            : start;
      const segText =
        typeof seg.text === 'string'
          ? seg.text
          : typeof seg.content === 'string'
            ? seg.content
            : '';
      if (!segText.trim()) continue;
      segments.push({ start, end, text: segText });
    }

    if (!segments.length && text.trim()) {
      segments.push({ start: 0, end: duration ?? 0, text: text.trim() });
    }

    return { text: text || segments.map((s) => s.text).join(' '), language, duration, segments };
  }

  private mockResult(filePath: string, language?: string | null): SttResult {
    const name = path.basename(filePath);
    const lang = language || process.env.STT_DEFAULT_LANGUAGE || 'zh';
    this.logger.log(`STT_MOCK: fake transcript for ${name}`);
    return {
      text: '这是模拟转写结果。Hello from STT mock.',
      language: lang,
      duration: 125,
      segments: [
        { start: 0, end: 12, text: '这是模拟转写结果。' },
        { start: 12, end: 45, text: '会议讨论了登录改版与后端接口分工。' },
        { start: 72, end: 125, text: 'Hello from STT mock. Action items follow next week.' },
      ],
    };
  }
}
