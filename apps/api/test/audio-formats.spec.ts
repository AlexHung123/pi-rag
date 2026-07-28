import { describe, expect, it } from 'vitest';
import {
  isAudioFilename,
  isAudioMime,
  isAudioUpload,
  extensionOf,
} from '../src/transcription/audio-formats';

describe('audio-formats', () => {
  it('detects extensions', () => {
    expect(isAudioFilename('a.mp3')).toBe(true);
    expect(isAudioFilename('a.M4A')).toBe(true);
    expect(isAudioFilename('notes.pdf')).toBe(false);
    expect(extensionOf('path/to/x.wav')).toBe('wav');
  });

  it('detects mime types', () => {
    expect(isAudioMime('audio/mpeg')).toBe(true);
    expect(isAudioMime('video/mp4')).toBe(true);
    expect(isAudioMime('application/pdf')).toBe(false);
  });

  it('isAudioUpload prefers extension', () => {
    expect(isAudioUpload('meeting.m4a', 'application/octet-stream')).toBe(true);
    expect(isAudioUpload('doc.pdf', 'audio/mpeg')).toBe(false);
  });
});
