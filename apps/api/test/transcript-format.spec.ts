import { describe, expect, it } from 'vitest';
import {
  buildTranscriptMarkdown,
  formatTimestamp,
  transcriptRagflowFilename,
} from '../src/transcription/transcript-format';

describe('formatTimestamp', () => {
  it('formats under one hour as MM:SS', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(72)).toBe('01:12');
    expect(formatTimestamp(3599)).toBe('59:59');
  });

  it('formats one hour+ as HH:MM:SS', () => {
    expect(formatTimestamp(3600)).toBe('01:00:00');
    expect(formatTimestamp(3661)).toBe('01:01:01');
  });
});

describe('buildTranscriptMarkdown', () => {
  it('includes metadata and timestamped bullets', () => {
    const md = buildTranscriptMarkdown({
      title: '周会-0728',
      originalFilename: 'meeting.m4a',
      language: 'zh',
      durationSeconds: 125,
      transcribedAt: new Date('2026-07-28T10:00:00.000Z'),
      segments: [
        { start: 72, end: 80, text: '我们下周一发布登录改版' },
        { start: 220, end: 230, text: '后端接口由张三负责' },
      ],
    });
    expect(md).toContain('# 周会-0728');
    expect(md).toContain('**Source:** meeting.m4a');
    expect(md).toContain('**Language:** zh');
    expect(md).toContain('- [01:12] 我们下周一发布登录改版');
    expect(md).toContain('- [03:40] 后端接口由张三负责');
  });

  it('handles empty segments', () => {
    const md = buildTranscriptMarkdown({
      title: 'Empty',
      originalFilename: 'a.mp3',
      segments: [],
    });
    expect(md).toContain('_No speech detected._');
  });

  it('includes speaker labels when present', () => {
    const md = buildTranscriptMarkdown({
      title: 'Meeting',
      originalFilename: 'm.mp4',
      language: 'yue',
      segments: [
        { start: 0, end: 5, text: '你好', speaker: 'spk0' },
        { start: 5, end: 10, text: '大家好', speaker: 'spk1' },
      ],
    });
    expect(md).toContain('**[spk0]**');
    expect(md).toContain('**[spk1]**');
  });
});

describe('transcriptRagflowFilename', () => {
  it('appends .transcript.md', () => {
    expect(transcriptRagflowFilename('meeting.m4a')).toBe('meeting.transcript.md');
  });
});
