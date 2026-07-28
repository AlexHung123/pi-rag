import { describe, expect, it } from 'vitest';
import { transcriptionLogFields } from '../src/transcription/transcription-log';

describe('transcriptionLogFields', () => {
  it('formats key=value pairs', () => {
    const s = transcriptionLogFields({
      jobId: 'j1',
      documentId: 'd1',
      stage: 'transcribing',
      attempt: 2,
    });
    expect(s).toContain('jobId=j1');
    expect(s).toContain('documentId=d1');
    expect(s).toContain('stage=transcribing');
    expect(s).toContain('attempt=2');
  });

  it('strips transcript payload fields', () => {
    const s = transcriptionLogFields({
      jobId: 'j1',
      text: 'secret full transcript',
      transcript: 'also secret',
      markdown: '# full',
    });
    expect(s).toBe('jobId=j1');
    expect(s).not.toContain('secret');
  });
});
