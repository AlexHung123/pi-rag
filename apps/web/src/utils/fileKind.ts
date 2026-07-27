export type FileKind =
  | 'pdf'
  | 'image'
  | 'text'
  | 'html'
  | 'excel'
  | 'ppt'
  | 'docx'
  | 'other';

/** Infer preview renderer from a file name (extension-based). */
export function fileKind(name: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['xlsx', 'xls'].includes(ext)) return 'excel';
  if (['pptx', 'ppt'].includes(ext)) return 'ppt';
  if (ext === 'docx') return 'docx';
  if (
    ['txt', 'md', 'markdown', 'csv', 'json', 'log', 'xml', 'yml', 'yaml'].includes(
      ext,
    )
  ) {
    return 'text';
  }
  return 'other';
}

/** ZIP local file header magic bytes ("PK") — used to reject legacy .doc payloads. */
export async function isZipLikeBlob(blob: Blob): Promise<boolean> {
  try {
    const header = await blob.slice(0, 2).arrayBuffer();
    const bytes = new Uint8Array(header);
    return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  } catch {
    return false;
  }
}
