import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Collapse excess blank lines so list layouts stay compact. */
function normalizeMarkdown(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    // 3+ blank lines → one blank line
    .replace(/\n{3,}/g, '\n\n')
    // blank line after list marker only ("1.\n\nTitle" → "1. Title")
    .replace(/^(\s*(?:\d+[.)]|[-*+])\s*)\n+/gm, '$1')
    .trim();
}

export default function Markdown({ content }: { content: string }) {
  const text = normalizeMarkdown(content || '');

  return (
    <div className="content markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
