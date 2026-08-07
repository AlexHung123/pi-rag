import { fileKind, type FileKind } from '../utils/fileKind';

type Props = {
  name: string;
  size?: number;
  className?: string;
};

function glyph(kind: FileKind): string {
  switch (kind) {
    case 'pdf':
      return 'PDF';
    case 'image':
      return 'IMG';
    case 'excel':
      return 'XLS';
    case 'ppt':
      return 'PPT';
    case 'docx':
      return 'DOC';
    case 'html':
      return 'HTML';
    case 'text':
      return 'TXT';
    default:
      return 'FILE';
  }
}

/** Compact file-type glyph for chips / explorer rows (pi-web-inspired). */
export default function FileTypeIcon({ name, size = 16, className }: Props) {
  const kind = fileKind(name);
  return (
    <span
      className={`file-type-icon kind-${kind}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.42)) }}
      title={kind}
      aria-hidden
    >
      {glyph(kind)}
    </span>
  );
}
