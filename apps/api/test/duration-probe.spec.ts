import { describe, expect, it } from 'vitest';
import { probeDurationSeconds } from '../src/transcription/duration-probe';

describe('probeDurationSeconds', () => {
  it('returns null for missing file without throwing', async () => {
    const n = await probeDurationSeconds('/tmp/pi-rag-definitely-missing-audio-file.wav');
    expect(n).toBeNull();
  });
});
