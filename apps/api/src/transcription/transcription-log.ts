/**
 * Structured transcription logs — never include full transcript text at info.
 */
export function transcriptionLogFields(fields: {
  jobId?: string;
  documentId?: string;
  stage?: string;
  attempt?: number;
  ms?: number;
  [key: string]: string | number | boolean | undefined | null;
}): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    // Avoid accidental transcript dumps
    if (k === 'text' || k === 'transcript' || k === 'markdown') continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join(' ');
}
