import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { MemoryService } from '../memory/memory.service';
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
  type AgentToolTurnContext,
  type CitationSource,
} from './agent.tools';
import { importEsm } from './import-esm';
import { createLlmDebugHooks } from './llm-debug';
import {
  buildPiModel,
  isLlmConfigured,
  loadPiModelBundle,
} from './pi-model';
import { rewriteQueryForRetrieval } from '../rag/query-rewrite';
import { mergeCitationSources } from '../rag/evidence';
import { AgentRunToolGuard } from './agent-run-limits';
import {
  compactMessagesIfNeeded,
  getAgentCompactionSettings,
  summarizeWithChatCompletions,
  type CompactableMessage,
} from './agent-compaction';
import {
  buildToolEndSummary,
  userFacingLimitMessage,
} from './tool-summary';
import {
  extractSourcesFromAgentMessages,
  extractSourcesFromToolResult,
  RETRIEVAL_TOOL_NAMES,
} from './extract-sources';

export type AgentStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; name: string }
  | {
      type: 'tool_end';
      name: string;
      ok: boolean;
      summary?: string;
      hitCount?: number;
    }
  | {
      type: 'agent_status';
      kind: 'limit' | 'aborted' | 'info';
      message: string;
    }
  | { type: 'sources'; sources: CitationSource[] }
  | { type: 'done'; fullText: string; sources: CitationSource[]; aborted?: boolean }
  | { type: 'error'; message: string };

export type AgentRunOptions = {
  knowledgeBaseIds?: string[];
  /** Client disconnect / Stop button — aborts the in-flight agent run. */
  signal?: AbortSignal;
  /** Allowlisted model id for this prompt (defaults to OPENAI_MODEL). */
  modelId?: string;
};

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly memory: MemoryService,
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

    // Per-message model: switch on the pooled agent before this prompt.
    const modelId =
      typeof options.modelId === 'string' ? options.modelId.trim() : '';
    if (modelId) {
      session.agent.state.model = buildPiModel(modelId) as never;
    }

    // Keep tool closures in sync with this turn's user text (name spelling etc.).
    const turnCtx = (session.agent as PooledAgent & {
      __turnContext?: AgentToolTurnContext;
    }).__turnContext;
    if (turnCtx) {
      turnCtx.latestUserMessage = userMessage;
    }

    // Order: memory block → selected KB prefix → user message (spec).
    const memoryPrefix = await this.memory.buildPromptPrefix(userId);
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
    if (memoryPrefix) {
      promptText = `${memoryPrefix}${promptText}`;
    }

    const queue: AgentStreamEvent[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    /** Authoritative assistant text for this run (deltas or last message_end). */
    let fullText = '';
    let sources: CitationSource[] = [];
    let clientAborted = false;
    const externalSignal = options.signal;
    const guard = new AgentRunToolGuard();

    const push = (ev: AgentStreamEvent) => {
      queue.push(ev);
      notify?.();
    };

    const abortFromClient = () => {
      if (clientAborted) return;
      clientAborted = true;
      this.logger.debug(`abort requested for conversation ${conversationId}`);
      try {
        session.agent.abort();
      } catch {
        /* ignore */
      }
    };

    if (externalSignal?.aborted) {
      abortFromClient();
    }
    const onExternalAbort = () => abortFromClient();
    externalSignal?.addEventListener('abort', onExternalAbort);

    // Per-run tool caps (pooled agents reuse hooks; always rebind + clear).
    const prevBefore = session.agent.beforeToolCall;
    const prevAfter = session.agent.afterToolCall;
    session.agent.beforeToolCall = async (ctx) => {
      const name = String(ctx.toolCall?.name || 'tool');
      const decision = guard.beforeToolCall(name, ctx.args);
      if (!decision.allow) {
        this.logger.warn(
          `tool blocked conv=${conversationId} tool=${name}: ${decision.reason}`,
        );
        push({
          type: 'agent_status',
          kind: 'limit',
          message: userFacingLimitMessage(decision.reason),
        });
        if (guard.shouldHardStop) {
          try {
            session.agent.abort();
          } catch {
            /* ignore */
          }
        }
        return { block: true, reason: decision.reason };
      }
      return undefined;
    };
    session.agent.afterToolCall = async (ctx) => {
      const name = String(ctx.toolCall?.name || 'tool');
      guard.afterToolCall(name, ctx.args, Boolean(ctx.isError));
      // After hitting the global tool budget, prefer ending the run over more LLM turns.
      if (guard.toolCallCount >= 1 && guard.shouldHardStop) {
        return { terminate: true };
      }
      return undefined;
    };

    const unsubscribe = session.agent.subscribe((event: AgentPoolEvent) => {
      if (event.type === 'turn_start') {
        if (guard.onTurnStart()) {
          this.logger.warn(
            `max turns exceeded conv=${conversationId}; aborting agent`,
          );
          push({
            type: 'agent_status',
            kind: 'limit',
            message: userFacingLimitMessage(
              'Agent run was stopped (turn or tool limit).',
            ),
          });
          try {
            session.agent.abort();
          } catch {
            /* ignore */
          }
        }
      }
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

    // Lightweight memory compaction (bare Agent; does not touch Postgres).
    if (!clientAborted && !externalSignal?.aborted) {
      await this.maybeCompactAgent(session.agent, {
        conversationId,
        signal: externalSignal,
      });
    }

    const promptPromise = session.agent
      .prompt(promptText)
      .catch((err: unknown) => {
        if (clientAborted || externalSignal?.aborted) {
          // User Stop / client disconnect — not a hard failure.
          return;
        }
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
        if (externalSignal?.aborted) {
          abortFromClient();
        }
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
      const aborted =
        clientAborted ||
        externalSignal?.aborted === true ||
        /abort/i.test(String(session.agent.state.errorMessage || ''));

      if (session.agent.state.errorMessage && !fullText && !aborted) {
        const message = llmDebug.recordError(
          new Error(session.agent.state.errorMessage),
        );
        yield { type: 'error', message };
        fullText = message;
      }

      if (aborted && !fullText) {
        fullText = '(stopped)';
      }

      if (aborted) {
        yield {
          type: 'agent_status',
          kind: 'aborted',
          message: fullText === '(stopped)'
            ? 'Stopped by user.'
            : 'Run stopped; partial answer kept.',
        };
      }

      // Fallback: recover citation sources from tool results in agent history
      if (!sources.length) {
        const recovered = extractSourcesFromAgentMessages(session.agent.state.messages);
        if (recovered.length) {
          sources = recovered;
          yield { type: 'sources', sources };
        }
      }

      yield { type: 'done', fullText, sources, aborted };
    } finally {
      // Consumer early-return or client stop: force abort and wait so pool release is safe.
      if (!finished) {
        abortFromClient();
      }
      try {
        await promptPromise;
      } catch {
        /* already handled */
      }
      externalSignal?.removeEventListener('abort', onExternalAbort);
      session.agent.beforeToolCall = prevBefore;
      session.agent.afterToolCall = prevAfter;
      unsubscribe();
      this.pool.release(conversationId);
    }
  }

  /**
   * If in-memory transcript is over the token threshold, summarize older
   * messages and keep a recent tail on the pooled Agent.
   */
  private async maybeCompactAgent(
    agent: PooledAgent,
    opts: { conversationId: string; signal?: AbortSignal },
  ): Promise<void> {
    const settings = getAgentCompactionSettings();
    if (!settings.enabled) return;

    const model = agent.state.model as
      | { id?: string; baseUrl?: string; contextWindow?: number }
      | undefined;
    const contextWindow =
      typeof model?.contextWindow === 'number' && model.contextWindow > 0
        ? model.contextWindow
        : 256_000;
    const baseUrl = String(
      model?.baseUrl || process.env.OPENAI_BASE_URL || '',
    ).replace(/\/$/, '');
    const modelId = String(
      model?.id || process.env.OPENAI_MODEL || '',
    ).trim();
    const apiKey = (process.env.OPENAI_API_KEY || '').trim();

    const current = (agent.state.messages || []) as CompactableMessage[];
    if (current.length < 4) return;

    try {
      const result = await compactMessagesIfNeeded({
        messages: current,
        contextWindow,
        settings,
        signal: opts.signal,
        summarize: (toSum, signal) =>
          summarizeWithChatCompletions({
            baseUrl,
            apiKey: apiKey || undefined,
            model: modelId,
            messagesToSummarize: toSum,
            signal,
          }),
      });

      if (!result.compacted) return;

      agent.state.messages = result.messages as typeof agent.state.messages;
      this.logger.log(
        `compaction conv=${opts.conversationId} tokens ${result.tokensBefore}→${result.tokensAfter} ` +
          `keptFrom=${result.firstKeptIndex} hardDrop=${result.hardDrop}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `compaction skipped conv=${opts.conversationId}: ${message}`,
      );
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
        const isError = Boolean(event.isError);
        const { summary, hitCount } = buildToolEndSummary(
          toolName,
          event.result,
          isError,
        );
        push({
          type: 'tool_end',
          name: toolName,
          ok: !isError,
          summary,
          ...(hitCount !== undefined ? { hitCount } : {}),
        });
        if (!isError && RETRIEVAL_TOOL_NAMES.has(toolName)) {
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

    const turnContext: AgentToolTurnContext = { latestUserMessage: '' };
    const tools = createUserTools({
      userId: args.userId,
      knowledge: this.knowledge,
      ragflow: this.ragflow,
      prisma: this.prisma,
      memory: this.memory,
      turnContext,
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
    }) as unknown as PooledAgent & { __turnContext?: AgentToolTurnContext };

    agent.__turnContext = turnContext;
    return agent;
  }
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
