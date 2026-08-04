import { describe, expect, it } from 'vitest';
import { extractSourcesFromAgentMessages } from '../src/agent/extract-sources';

describe('extractSourcesFromAgentMessages', () => {
  const priorTool = {
    role: 'toolResult',
    toolName: 'retrieve_chunks',
    details: {
      sources: [
        {
          id: 'old-1',
          index: 1,
          content: 'prior turn chunk',
          documentName: 'old-doc.pdf',
        },
      ],
    },
  };

  const currentTool = {
    role: 'toolResult',
    toolName: 'retrieve_chunks',
    details: {
      sources: [
        {
          id: 'new-1',
          index: 1,
          content: 'this turn chunk',
          documentName: 'new-doc.pdf',
        },
      ],
    },
  };

  it('does not leak prior-turn sources when this turn has no tools (e.g. hello)', () => {
    const messages = [
      { role: 'user', content: 'what is in the lecture?' },
      priorTool,
      { role: 'assistant', content: 'Based on the lecture…' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi! How can I help?' },
    ];
    expect(extractSourcesFromAgentMessages(messages)).toEqual([]);
  });

  it('returns only sources after the latest user message', () => {
    const messages = [
      { role: 'user', content: 'first question' },
      priorTool,
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'second question' },
      currentTool,
      { role: 'assistant', content: 'answer 2' },
    ];
    const sources = extractSourcesFromAgentMessages(messages);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.id).toBe('new-1');
    expect(sources[0]?.documentName).toBe('new-doc.pdf');
  });

  it('merges multiple retrieval tools in the same turn', () => {
    const keywordTool = {
      role: 'toolResult',
      toolName: 'keyword_search',
      details: {
        sources: [
          {
            id: 'kw-1',
            index: 1,
            content: 'keyword hit',
            documentName: 'kw.pdf',
          },
        ],
      },
    };
    const messages = [
      { role: 'user', content: 'search both' },
      currentTool,
      { role: 'assistant', content: 'calling more tools' },
      keywordTool,
      { role: 'assistant', content: 'final' },
    ];
    const sources = extractSourcesFromAgentMessages(messages);
    expect(sources.map((s) => s.id).sort()).toEqual(['kw-1', 'new-1']);
  });

  it('ignores non-retrieval tool results', () => {
    const messages = [
      { role: 'user', content: 'remember this' },
      {
        role: 'toolResult',
        toolName: 'memory_add',
        details: { ok: true },
      },
      { role: 'assistant', content: 'saved' },
    ];
    expect(extractSourcesFromAgentMessages(messages)).toEqual([]);
  });
});
