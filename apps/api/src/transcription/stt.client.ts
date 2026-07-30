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

export type TranscribeFileOpts = {
  language?: string | null;
  /** Speaker diarization (FunASR: form field spk=true). */
  spk?: boolean;
};

/** Best-effort MIME so remote STT can treat .mp4 as video. */
function guessMime(filename: string): string | undefined {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.aac': 'audio/aac',
  };
  return map[ext];
}

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

  /** Whether to request speaker diarization (spk=true). */
  spkEnabled(opts?: TranscribeFileOpts): boolean {
    if (typeof opts?.spk === 'boolean') return opts.spk;
    const v = (process.env.STT_SPK || '').toLowerCase();
    return v === 'true' || v === '1';
  }

  async transcribeFile(
    filePath: string,
    opts?: TranscribeFileOpts,
  ): Promise<SttResult> {
    this.assertConfigured();
    if (this.isMock()) {
      return this.mockResult(filePath, opts?.language, this.spkEnabled(opts));
    }

    const base = (process.env.STT_BASE_URL || '').replace(/\/$/, '');
    const apiKey = (process.env.STT_API_KEY || '').trim();
    // FunASR server model ids (e.g. sensevoice); empty lets server default
    const model = (process.env.STT_MODEL || 'sensevoice').trim();
    const timeoutMs = Number(process.env.STT_TIMEOUT_MS || 3_600_000);
    // yue = Cantonese (SenseVoice); use auto for mixed meetings
    const language =
      (opts?.language || process.env.STT_DEFAULT_LANGUAGE || 'yue').trim() ||
      undefined;
    const spk = this.spkEnabled(opts);

    if (!fs.existsSync(filePath)) {
      throw new Error(`audio file not found: ${filePath}`);
    }

    const filename = path.basename(filePath);
    // Preserve extension in multipart filename so remote STT can detect .mp4
    // and run in-process ffmpeg → 16k mono wav before SenseVoice.
    const mime = guessMime(filename);
    let fileBlob: Blob;
    try {
      const openAsBlob = (fs as unknown as {
        openAsBlob?: (p: string, opts?: { type?: string }) => Promise<Blob>;
      }).openAsBlob;
      if (typeof openAsBlob === 'function') {
        fileBlob = await openAsBlob(filePath, mime ? { type: mime } : undefined);
      } else {
        fileBlob = new Blob([fs.readFileSync(filePath)], {
          type: mime || 'application/octet-stream',
        });
      }
    } catch {
      fileBlob = new Blob([fs.readFileSync(filePath)], {
        type: mime || 'application/octet-stream',
      });
    }
    const form = new FormData();
    form.append('file', fileBlob, filename);
    // Prefer verbose_json for timestamps (and speaker when spk=true)
    form.append('response_format', 'verbose_json');
    if (model) form.append('model', model);
    if (language) form.append('language', this.mapLanguageForStt(language));
    // FunASR / your server: Form spk: bool
    if (spk) form.append('spk', 'true');

    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = `${base}/v1/audio/transcriptions`;
    this.logger.log(
      `STT request model=${model || '-'} lang=${language || '-'} spk=${spk} file=${filename}`,
    );
    try {
      const res = await fetch(url, {
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

  /** Map UI/aliases to SenseVoice / FunASR language codes. */
  mapLanguageForStt(lang: string): string {
    const l = lang.trim().toLowerCase();
    const aliases: Record<string, string> = {
      cantonese: 'yue',
      'yue-hk': 'yue',
      'zh-yue': 'yue',
      'zh-hk': 'yue',
      mandarin: 'zh',
      chinese: 'zh',
      'zh-cn': 'zh',
      'zh-hans': 'zh',
    };
    return aliases[l] || l;
  }

  /** Strip SenseVoice-style tags like <|yue|><|NEUTRAL|> from text. */
  stripSenseVoiceTags(text: string): string {
    return (text || '').replace(/<\|[^|]*\|>/g, '').replace(/\s+/g, ' ').trim();
  }

  normalizeResponse(body: string, fallbackLanguage?: string): SttResult {
    const trimmed = (body || '').trim();
    if (!trimmed) {
      return { text: '', language: fallbackLanguage, segments: [] };
    }

    // Plain text fallback
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      const plain = this.stripSenseVoiceTags(trimmed);
      return {
        text: plain,
        language: fallbackLanguage,
        segments: plain ? [{ start: 0, end: 0, text: plain }] : [],
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      const plain = this.stripSenseVoiceTags(trimmed);
      return {
        text: plain,
        language: fallbackLanguage,
        segments: plain ? [{ start: 0, end: 0, text: plain }] : [],
      };
    }

    const obj = json as Record<string, unknown>;
    let text =
      typeof obj.text === 'string'
        ? obj.text
        : typeof obj.transcript === 'string'
          ? obj.transcript
          : '';
    text = this.stripSenseVoiceTags(text);

    const language =
      (typeof obj.language === 'string' ? obj.language : undefined) ||
      fallbackLanguage;
    const duration =
      typeof obj.duration === 'number'
        ? obj.duration
        : typeof obj.duration_seconds === 'number'
          ? obj.duration_seconds
          : undefined;

    // OpenAI-style segments, or FunASR sentence_info (ms timestamps)
    const rawSegs = Array.isArray(obj.segments)
      ? obj.segments
      : Array.isArray(obj.sentence_info)
        ? obj.sentence_info
        : [];
    const segments: TranscriptSegment[] = [];
    for (const s of rawSegs) {
      if (!s || typeof s !== 'object') continue;
      const seg = s as Record<string, unknown>;
      let start =
        typeof seg.start === 'number'
          ? seg.start
          : typeof seg.start_time === 'number'
            ? seg.start_time
            : 0;
      let end =
        typeof seg.end === 'number'
          ? seg.end
          : typeof seg.end_time === 'number'
            ? seg.end_time
            : start;
      // FunASR often reports milliseconds
      if (end > 1000 || start > 1000) {
        start = start / 1000;
        end = end / 1000;
      }
      const segText = this.stripSenseVoiceTags(
        typeof seg.text === 'string'
          ? seg.text
          : typeof seg.content === 'string'
            ? seg.content
            : '',
      );
      if (!segText) continue;
      const speakerRaw =
        seg.spk ??
        seg.speaker ??
        seg.speaker_id ??
        seg.speaker_label ??
        null;
      const speaker =
        speakerRaw != null && String(speakerRaw).trim()
          ? String(speakerRaw).trim()
          : null;
      segments.push({ start, end, text: segText, speaker });
    }

    if (!segments.length && text) {
      segments.push({ start: 0, end: duration ?? 0, text });
    }

    return {
      text: text || segments.map((s) => s.text).join(' '),
      language,
      duration,
      segments,
    };
  }

  private mockResult(
    filePath: string,
    language?: string | null,
    spk = false,
  ): SttResult {
    const name = path.basename(filePath);
    const lang = language || process.env.STT_DEFAULT_LANGUAGE || 'yue';
    this.logger.log(`STT_MOCK: fake transcript for ${name} spk=${spk}`);
    return {
      text: '这是模拟转写结果。Hello from STT mock.',
      language: lang,
      duration: 125,
      segments: [
        {
          start: 0,
          end: 12,
          text: '这是模拟转写结果。',
          speaker: spk ? 'spk0' : null,
        },
        {
          start: 12,
          end: 45,
          text: '会议讨论了登录改版与后端接口分工。',
          speaker: spk ? 'spk1' : null,
        },
        {
          start: 72,
          end: 125,
          text: 'Hello from STT mock. Action items follow next week.',
          speaker: spk ? 'spk0' : null,
        },
      ],
    };
  }
}
