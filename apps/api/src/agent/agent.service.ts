import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AgentSessionPool,
  type AgentPoolEvent,
  type PooledAgent,
} from './agent-session.pool';
import {
  buildSelectedKbPromptPrefix,
  createUserTools,
  DOMAIN_SYSTEM_PROMPT,
  type CitationSource,
} from './agent.tools';
import { importEsm } from './import-esm';
import { createLlmDebugHooks } from './llm-debug';
import { isLlmConfigured, loadPiModelBundle } from './pi-model';
import { rewriteQueryForRetrieval } from '../rag/query-rewrite';
import { mergeCitationSources } from '../rag/evidence';

/** Tools that may attach details.sources for the citation UI. */
const RETRIEVAL_TOOL_NAMES = new Set([
  'retrieve_chunks',
  'keyword_search',
  'list_document_chunks',
]);

export type AgentStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; ok: boolean }
  | { type: 'sources'; sources: CitationSource[] }
  | { type: 'done'; fullText: string; sources: CitationSource[] }
  | { type: 'error'; message: string };

export type AgentRunOptions = {
  knowledgeBaseIds?: string[];
};

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly ragflow: RagflowService,
    private readonly prisma: PrismaService,
    private readonly pool: AgentSessionPool,
  ) {}

  /** Drop a live agent when its conversation is deleted. */
  disposeConversation(conversationId: string): void {
    this.pool.dispose(conversationId);
  }

  /**
   * Stream an assistant reply via a pooled pi-agent-core Agent.
   * One agent instance per conversation while the pool slot lives.
   */
  async *run(
    userId: string,
    conversationId: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    userMessage: string,
    options: AgentRunOptions = {},
  ): AsyncGenerator<AgentStreamEvent> {
    if (!isLlmConfigured()) {
      const msg =
        'LLM is not configured. Set OPENAI_BASE_URL and/or OPENAI_API_KEY on the API.';
      yield { type: 'error', message: msg };
      yield { type: 'text_delta', delta: msg };
      yield { type: 'done', fullText: msg, sources: [] };
      return;
    }

    let session;
    try {
      session = await this.pool.acquire(
        userId,
        conversationId,
        history,
        (args) => this.createAgent(args),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to acquire agent session: ${message}`);
      yield { type: 'error', message };
      yield { type: 'text_delta', delta: message };
      yield { type: 'done', fullText: message, sources: [] };
      return;
    }

    const selectedKbIds = (options.knowledgeBaseIds || []).filter(Boolean);
    let promptText = userMessage;
    if (selectedKbIds.length) {
      const owned = await this.knowledge.list(userId);
      const selected = owned
        .filter((k) => selectedKbIds.includes(k.id))
        .map((k) => ({ id: k.id, name: k.name }));
      if (selected.length) {
        // Multi-turn: rewrite into a self-contained retrieval hint for the agent.
        const rewritten = await rewriteQueryForRetrieval(userMessage, history);
        if (rewritten.rewritten) {
          this.logger.debug(
            `query rewrite: "${rewritten.original.slice(0, 60)}" → "${rewritten.rewriteQuery.slice(0, 60)}"`,
          );
        }
        promptText = `${buildSelectedKbPromptPrefix(selected, {
          rewriteQuery: rewritten.rewritten
            ? rewritten.rewriteQuery
            : undefined,
        })}${userMessage}`;
      }
    }

    const queue: AgentStreamEvent[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    /** Authoritative assistant text for this run (deltas or last message_end). */
    let fullText = '';
    let sources: CitationSource[] = [];

    const push = (ev: AgentStreamEvent) => {
      queue.push(ev);
      notify?.();
    };

    const unsubscribe = session.agent.subscribe((event: AgentPoolEvent) => {
      this.mapEvent(
        event,
        push,
        (delta) => {
          fullText += delta;
        },
        (finalText) => {
          // message_end is the complete assistant text for that turn
          fullText = finalText;
        },
        (nextSources) => {
          if (nextSources.length) {
            // Merge across multiple retrieval tools in one turn; re-index [n].
            sources = mergeCitationSources(sources, nextSources);
            push({ type: 'sources', sources });
          }
        },
      );
    });

    // Capture exact chat/completions payload for gateway 500 debugging
    const llmDebug = createLlmDebugHooks({
      conversationId,
      baseUrl: String(
        session.agent.state.model?.baseUrl || process.env.OPENAI_BASE_URL || '',
      ),
      modelId: String(
        session.agent.state.model?.id || process.env.OPENAI_MODEL || '',
      ),
    });
    // pi-agent-core reads these from the Agent instance each loop turn
    session.agent.onPayload = llmDebug.onPayload;
    session.agent.onResponse = llmDebug.onResponse;

    const promptPromise = session.agent
      .prompt(promptText)
      .catch((err: unknown) => {
        const message = llmDebug.recordError(err);
        this.logger.warn(`agent.prompt failed: ${message}`);
        push({ type: 'error', message });
      })
      .finally(() => {
        finished = true;
        notify?.();
      });

    try {
      while (!finished || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
            if (finished || queue.length > 0) {
              notify = null;
              resolve();
            }
          });
          notify = null;
          continue;
        }
        yield queue.shift()!;
      }

      await promptPromise;

      if (!fullText) {
        fullText =
          extractAssistantText(session.agent) ||
          session.agent.state.errorMessage ||
          '';
      }
      if (session.agent.state.errorMessage && !fullText) {
        const message = llmDebug.recordError(
          new Error(session.agent.state.errorMessage),
        );
        yield { type: 'error', message };
        fullText = message;
      }

      // Fallback: recover citation sources from tool results in agent history
      if (!sources.length) {
        const recovered = extractSourcesFromAgentMessages(session.agent.state.messages);
        if (recovered.length) {
          sources = recovered;
          yield { type: 'sources', sources };
        }
      }

      yield { type: 'done', fullText, sources };
    } finally {
      unsubscribe();
      this.pool.release(conversationId);
    }
  }

  private mapEvent(
    event: AgentPoolEvent,
    push: (ev: AgentStreamEvent) => void,
    onTextDelta: (delta: string) => void,
    onAssistantComplete: (text: string) => void,
    onSources: (sources: CitationSource[]) => void,
  ): void {
    switch (event.type) {
      case 'tool_execution_start':
        push({ type: 'tool_start', name: String(event.toolName || 'tool') });
        break;
      case 'tool_execution_end': {
        const toolName = String(event.toolName || 'tool');
        push({
          type: 'tool_end',
          name: toolName,
          ok: !event.isError,
        });
        if (!event.isError && RETRIEVAL_TOOL_NAMES.has(toolName)) {
          const extracted = extractSourcesFromToolResult(event.result);
          if (extracted.length) onSources(extracted);
        }
        break;
      }
      case 'message_update': {
        const ame = event.assistantMessageEvent;
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          onTextDelta(ame.delta);
          push({ type: 'text_delta', delta: ame.delta });
        }
        break;
      }
      case 'message_end': {
        const text = messageToText(event.message);
        if (text) onAssistantComplete(text);
        break;
      }
      default:
        break;
    }
  }

  private async createAgent(args: {
    conversationId: string;
    userId: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<PooledAgent> {
    const { Agent } = await importEsm<{
      Agent: new (options?: unknown) => PooledAgent;
    }>('@earendil-works/pi-agent-core');
    const bundle = await loadPiModelBundle();
    const historyLimit = Number(process.env.AGENT_HISTORY_LIMIT || 20);
    const limit = Number.isFinite(historyLimit) && historyLimit > 0 ? historyLimit : 20;
    const slice = args.history.slice(-limit);

    const tools = createUserTools({
      userId: args.userId,
      knowledge: this.knowledge,
      ragflow: this.ragflow,
      prisma: this.prisma,
    });

    const messages = slice.map((m) => {
      if (m.role === 'user') {
        return {
          role: 'user' as const,
          content: m.content,
          timestamp: Date.now(),
        };
      }
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: m.content }],
        api: 'openai-completions' as const,
        provider: 'local-openai',
        model: bundle.model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      };
    });

    const agent = new Agent({
      initialState: {
        systemPrompt: DOMAIN_SYSTEM_PROMPT,
        model: bundle.model as never,
        thinkingLevel: 'off',
        tools: tools as never,
        messages: messages as never,
      },
      streamFn: bundle.streamSimple as never,
      getApiKey: () => bundle.getApiKey(),
      sessionId: args.conversationId,
      toolExecution: 'sequential',
    });

    return agent as unknown as PooledAgent;
  }
}

function mapHitsToSources(hits: unknown[]): CitationSource[] {
  return hits.map((h, i) => {
    const hit = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
    const score = typeof hit.score === 'number' ? hit.score : undefined;
    return {
      id: String(hit.id || `hit-${i + 1}`),
      content: String(hit.content || ''),
      documentName:
        typeof hit.documentName === 'string' ? hit.documentName : undefined,
      documentId:
        typeof hit.documentId === 'string' ? hit.documentId : undefined,
      appDocumentId:
        typeof hit.appDocumentId === 'string' ? hit.appDocumentId : undefined,
      knowledgeBaseId:
        typeof hit.knowledgeBaseId === 'string'
          ? hit.knowledgeBaseId
          : undefined,
      knowledgeBaseName:
        typeof hit.knowledgeBaseName === 'string'
          ? hit.knowledgeBaseName
          : undefined,
      score,
      index: typeof hit.index === 'number' ? hit.index : i + 1,
      evidenceLabel:
        typeof hit.evidenceLabel === 'string'
          ? hit.evidenceLabel
          : typeof score === 'number' && score >= 0.75
            ? 'Strong evidence'
            : typeof score === 'number' && score >= 0.5
              ? 'Moderate evidence'
              : 'Evidence',
      positions: Array.isArray(hit.positions)
        ? (hit.positions as number[][])
        : undefined,
    } satisfies CitationSource;
  });
}

function extractSourcesFromToolResult(result: unknown): CitationSource[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as {
    details?: unknown;
    content?: unknown;
  };

  // Prefer structured details from retrieve_chunks
  if (r.details && typeof r.details === 'object') {
    const d = r.details as { sources?: unknown; hits?: unknown };
    if (Array.isArray(d.sources) && d.sources.length) {
      return d.sources as CitationSource[];
    }
    if (Array.isArray(d.hits) && d.hits.length) {
      return mapHitsToSources(d.hits);
    }
  }

  // Fallback: parse JSON text content from the tool result
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (!block || typeof block !== 'object') continue;
      const text = String((block as { text?: string }).text || '');
      if (!text.trim()) continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed) && parsed.length) {
          return mapHitsToSources(parsed);
        }
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as { hits?: unknown; sources?: unknown };
          if (Array.isArray(obj.sources) && obj.sources.length) {
            return obj.sources as CitationSource[];
          }
          if (Array.isArray(obj.hits) && obj.hits.length) {
            return mapHitsToSources(obj.hits);
          }
        }
      } catch {
        /* not JSON */
      }
    }
  }

  return [];
}

/**
 * Scan agent message history for retrieval tool results (this turn).
 * Merges sources from retrieve_chunks / keyword_search / list_document_chunks.
 */
function extractSourcesFromAgentMessages(
  messages: Array<{ role: string; content?: unknown; details?: unknown; toolName?: string }>,
): CitationSource[] {
  // Walk from the end; stop when we leave the latest assistant turn's tools.
  const batches: CitationSource[][] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const role = String(m.role || '');
    if (role === 'assistant' && batches.length) break;
    if (role === 'user' && batches.length) break;
    if (role === 'toolResult' || role === 'tool') {
      const toolName = String(m.toolName || '');
      if (toolName && !RETRIEVAL_TOOL_NAMES.has(toolName)) continue;
      // If toolName missing, still try to parse details.sources
      const fromDetails = extractSourcesFromToolResult({
        details: m.details,
        content: m.content,
      });
      if (fromDetails.length) batches.push(fromDetails);
    }
  }
  if (!batches.length) return [];
  return mergeCitationSources(...batches);
}

function messageToText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as { role?: string; content?: unknown };
  if (m.role !== 'assistant') return '';
  const content = m.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        return String((block as { text?: string }).text || '');
      }
      return '';
    })
    .join('');
}

function extractAssistantText(agent: PooledAgent): string {
  const msgs = agent.state.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === 'assistant') {
      return messageToText(m);
    }
  }
  return '';
}
