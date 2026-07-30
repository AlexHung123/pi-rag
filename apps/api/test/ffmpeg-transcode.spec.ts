import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { needsWavTranscode } from '../src/transcription/audio-formats';
import { transcodeToWav16kMono } from '../src/transcription/ffmpeg-transcode';

describe('ffmpeg-transcode', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('needsWavTranscode for mp4', () => {
    expect(needsWavTranscode('meeting.mp4')).toBe(true);
  });

  it('transcodes a tiny generated wav via ffmpeg when available', async () => {
    // Skip if ffmpeg not on PATH (CI / minimal hosts)
    try {
      const { execFileSync } = await import('child_process');
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    } catch {
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rag-ff-'));
    dirs.push(dir);
    // Minimal valid-ish: create silent wav with ffmpeg first as input, then re-encode
    const input = path.join(dir, 'in.wav');
    const mid = path.join(dir, 'mid.mp4');
    const out = path.join(dir, 'meeting.wav');
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    await execFileAsync(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.2', input],
      { timeout: 30_000 },
    );
    // Wrap as mp4 audio for the video-path pipeline
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', input, '-c:a', 'aac', mid],
      { timeout: 30_000 },
    );
    await transcodeToWav16kMono(mid, out);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(100);
  }, 60_000);
});
