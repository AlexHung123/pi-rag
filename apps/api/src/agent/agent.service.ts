import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { DocumentsService } from '../documents/documents.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { PrismaService } from '../prisma/prisma.service';
import { createUserTools, DOMAIN_SYSTEM_PROMPT } from './agent.tools';

export type AgentStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; ok: boolean }
  | { type: 'done'; fullText: string }
  | { type: 'error'; message: string };

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly documents: DocumentsService,
    private readonly ragflow: RagflowService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Stream an assistant reply. Uses OpenAI-compatible chat when configured;
   * otherwise a deterministic tool-assisted fallback that still enforces ownership.
   */
  async *run(
    userId: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    userMessage: string,
  ): AsyncGenerator<AgentStreamEvent> {
    const tools = createUserTools({
      userId,
      knowledge: this.knowledge,
      documents: this.documents,
      ragflow: this.ragflow,
      prisma: this.prisma,
    });

    const apiKey = process.env.OPENAI_API_KEY || '';
    if (apiKey) {
      try {
        yield* this.runWithOpenAI(tools, history, userMessage, apiKey);
        return;
      } catch (err) {
        this.logger.warn(
          `OpenAI agent path failed, falling back: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    yield* this.runFallback(tools, userMessage);
  }

  private async *runWithOpenAI(
    tools: ReturnType<typeof createUserTools>,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    userMessage: string,
    apiKey: string,
  ): AsyncGenerator<AgentStreamEvent> {
    const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
      /\/$/,
      '',
    );
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const toolDefs = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
      },
    }));

    type Msg =
      | { role: 'system' | 'user' | 'assistant'; content: string }
      | {
          role: 'assistant';
          content: string | null;
          tool_calls: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        }
      | { role: 'tool'; tool_call_id: string; content: string };

    const messages: Msg[] = [
      { role: 'system', content: DOMAIN_SYSTEM_PROMPT },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];

    let full = '';
    for (let turn = 0; turn < 6; turn++) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          tools: toolDefs,
          tool_choice: 'auto',
          stream: false,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      };
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new Error('empty LLM response');

      if (msg.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: tc.function,
          })),
        });
        for (const tc of msg.tool_calls) {
          const tool = tools.find((t) => t.name === tc.function.name);
          yield { type: 'tool_start', name: tc.function.name };
          try {
            const args = tc.function.arguments
              ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
              : {};
            if (!tool) throw new Error(`unknown tool ${tc.function.name}`);
            const result = await tool.execute(tc.id, args, undefined, undefined);
            const text = result.content
              .map((c) => ('text' in c ? c.text : ''))
              .join('\n');
            messages.push({ role: 'tool', tool_call_id: tc.id, content: text });
            yield { type: 'tool_end', name: tc.function.name, ok: true };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: ${message}`,
            });
            yield { type: 'tool_end', name: tc.function.name, ok: false };
          }
        }
        continue;
      }

      const content = msg.content || '';
      full = content;
      // stream in chunks for UX
      const step = 24;
      for (let i = 0; i < content.length; i += step) {
        yield { type: 'text_delta', delta: content.slice(i, i + step) };
      }
      yield { type: 'done', fullText: full };
      return;
    }

    full = 'I reached the tool-call limit. Please try a simpler request.';
    yield { type: 'text_delta', delta: full };
    yield { type: 'done', fullText: full };
  }

  private async *runFallback(
    tools: ReturnType<typeof createUserTools>,
    userMessage: string,
  ): AsyncGenerator<AgentStreamEvent> {
    const lower = userMessage.toLowerCase();
    let full = '';

    const emit = async function* (this: void, text: string) {
      full = text;
      const step = 32;
      for (let i = 0; i < text.length; i += step) {
        yield { type: 'text_delta' as const, delta: text.slice(i, i + step) };
      }
      yield { type: 'done' as const, fullText: text };
    };

    // Create KB intent
    const createMatch = userMessage.match(
      /(?:create|新建|建立|创建).{0,12}(?:knowledge base|kb|知识库|知識庫)\s*[「"']?(.+?)[」"']?\s*$/i,
    );
    if (
      createMatch ||
      lower.includes('create knowledge base') ||
      lower.includes('新建知识库') ||
      lower.includes('创建知識庫')
    ) {
      const name =
        createMatch?.[1]?.trim() ||
        userMessage.replace(/.*(?:named|叫|：|:)\s*/i, '').trim() ||
        `KB ${new Date().toISOString().slice(0, 10)}`;
      const tool = tools.find((t) => t.name === 'create_knowledge_base')!;
      yield { type: 'tool_start', name: tool.name };
      try {
        const result = await tool.execute(
          'local',
          { name: name.slice(0, 80) },
          undefined,
          undefined,
        );
        yield { type: 'tool_end', name: tool.name, ok: true };
        const text = `Created knowledge base.\n\n${result.content.map((c) => ('text' in c ? c.text : '')).join('')}`;
        yield* emit(text);
      } catch (err) {
        yield { type: 'tool_end', name: tool.name, ok: false };
        yield* emit(`Failed to create knowledge base: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    if (
      lower.includes('list') &&
      (lower.includes('knowledge') || lower.includes('kb') || lower.includes('知识库') || lower.includes('知識庫'))
    ) {
      const tool = tools.find((t) => t.name === 'list_my_knowledge_bases')!;
      yield { type: 'tool_start', name: tool.name };
      const result = await tool.execute('local', {}, undefined, undefined);
      yield { type: 'tool_end', name: tool.name, ok: true };
      yield* emit(`Your knowledge bases:\n\n${result.content.map((c) => ('text' in c ? c.text : '')).join('')}`);
      return;
    }

    // Default: retrieve then answer from chunks
    const retrieve = tools.find((t) => t.name === 'retrieve_chunks')!;
    yield { type: 'tool_start', name: retrieve.name };
    const result = await retrieve.execute(
      'local',
      { question: userMessage, topK: 5 },
      undefined,
      undefined,
    );
    yield { type: 'tool_end', name: retrieve.name, ok: true };
    const raw = result.content.map((c) => ('text' in c ? c.text : '')).join('');
    let hits: Array<{ content: string; documentName?: string; score?: number }> = [];
    try {
      hits = JSON.parse(raw) as typeof hits;
    } catch {
      hits = [];
    }

    if (!hits.length) {
      yield* emit(
        [
          'I could not find relevant chunks in your knowledge bases.',
          '',
          'Tips:',
          '1. Create a knowledge base (sidebar → Knowledge)',
          '2. Upload a document',
          '3. Click **Parse** to cut chunks',
          '4. Ask again',
          '',
          'Set `OPENAI_API_KEY` on the API for full LLM + tool calling via the chat agent.',
        ].join('\n'),
      );
      return;
    }

    const context = hits
      .map(
        (h, i) =>
          `[${i + 1}] ${h.documentName || 'document'} (score=${h.score ?? '?'}):\n${h.content}`,
      )
      .join('\n\n');

    yield* emit(
      [
        'Based on your knowledge base (retrieval fallback, no LLM key configured):',
        '',
        context,
        '',
        '---',
        'Configure `OPENAI_API_KEY` (and optional `OPENAI_BASE_URL` / `OPENAI_MODEL`) for synthesized expert answers.',
      ].join('\n'),
    );
  }
}
