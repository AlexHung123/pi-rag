import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaStorage } from '../src/transcription/media-storage';

const USER = '11111111-1111-1111-1111-111111111111';
const DOC = '22222222-2222-2222-2222-222222222222';

describe('MediaStorage', () => {
  let root: string;
  let media: MediaStorage;
  const prevRoot = process.env.MEDIA_ROOT;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rag-media-'));
    process.env.MEDIA_ROOT = root;
    media = new MediaStorage();
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes and removes source audio under MEDIA_ROOT', () => {
    const { relativePath, absolutePath } = media.writeSourceAudio(
      USER,
      DOC,
      'm4a',
      Buffer.from('audio-bytes'),
    );
    expect(relativePath).toBe(`${USER}/${DOC}/source.m4a`);
    expect(fs.existsSync(absolutePath)).toBe(true);
    expect(fs.readFileSync(absolutePath).toString()).toBe('audio-bytes');

    media.removeDocDir(USER, DOC);
    expect(fs.existsSync(path.join(root, USER, DOC))).toBe(false);
  });

  it('rejects path traversal', () => {
    expect(() => media.resolveSafe('../etc/passwd')).toThrow();
  });

  it('places source from temp via rename', () => {
    const incoming = media.incomingDir();
    const temp = path.join(incoming, 'upload-temp.m4a');
    fs.writeFileSync(temp, 'from-disk');
    const { relativePath, absolutePath } = media.placeSourceFromTemp(
      USER,
      DOC,
      'm4a',
      temp,
    );
    expect(relativePath).toBe(`${USER}/${DOC}/source.m4a`);
    expect(fs.existsSync(absolutePath)).toBe(true);
    expect(fs.readFileSync(absolutePath).toString()).toBe('from-disk');
    expect(fs.existsSync(temp)).toBe(false);
  });

  it('detects existing transcript for smart retry', () => {
    expect(media.hasTranscript(USER, DOC)).toBe(false);
    media.writeTranscript(USER, DOC, '# hello\n');
    expect(media.hasTranscript(USER, DOC)).toBe(true);
    expect(media.readTranscriptIfExists(USER, DOC)).toContain('# hello');
  });
});

