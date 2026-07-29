import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SttClient } from '../src/transcription/stt.client';

describe('SttClient', () => {
  const prev = { ...process.env };

  beforeEach(() => {
    process.env.STT_MOCK = 'true';
    delete process.env.STT_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...prev };
  });

  it('is configured when mock is on', () => {
    const client = new SttClient();
    expect(client.isConfigured()).toBe(true);
  });

  it('mock returns multi-segment result', async () => {
    const client = new SttClient();
    const result = await client.transcribeFile('/tmp/fake.m4a', { language: 'zh' });
    expect(result.segments.length).toBeGreaterThan(1);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.language).toBe('zh');
  });

  it('normalizeResponse handles verbose_json shape', () => {
    const client = new SttClient();
    const result = client.normalizeResponse(
      JSON.stringify({
        text: 'hello world',
        language: 'en',
        duration: 10,
        segments: [
          { start: 0, end: 5, text: 'hello' },
          { start: 5, end: 10, text: 'world' },
        ],
      }),
    );
    expect(result.segments).toHaveLength(2);
    expect(result.duration).toBe(10);
  });

  it('normalizeResponse falls back for plain text', () => {
    const client = new SttClient();
    const result = client.normalizeResponse('just text');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe('just text');
  });

  it('strips SenseVoice tags and maps language aliases', () => {
    const client = new SttClient();
    expect(client.mapLanguageForStt('cantonese')).toBe('yue');
    expect(client.mapLanguageForStt('zh-HK')).toBe('yue');
    const result = client.normalizeResponse(
      JSON.stringify({
        text: '<|yue|><|NEUTRAL|>呢句系粤语',
        language: 'yue',
        duration: 2,
        segments: [{ start: 0, end: 2, text: '<|yue|>呢句系粤语' }],
      }),
    );
    expect(result.text).toBe('呢句系粤语');
    expect(result.segments[0].text).toBe('呢句系粤语');
  });

  it('assertConfigured fails when mock off and no base url', () => {
    process.env.STT_MOCK = 'false';
    delete process.env.STT_BASE_URL;
    const client = new SttClient();
    expect(() => client.assertConfigured()).toThrow(/STT is not configured/);
  });
});
