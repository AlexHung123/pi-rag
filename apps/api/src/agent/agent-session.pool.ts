import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/** Minimal surface of pi-agent-core Agent used by the pool. */
export type PooledAgent = {
  prompt: (input: string) => Promise<void>;
  subscribe: (
    listener: (event: AgentPoolEvent, signal: AbortSignal) => void | Promise<void>,
  ) => () => void;
  waitForIdle: () => Promise<void>;
  abort: () => void;
  state: {
    model?: { id?: string; baseUrl?: string; provider?: string };
    messages: Array<{ role: string; content?: unknown; errorMessage?: string }>;
    errorMessage?: string;
    isStreaming: boolean;
  };
  sessionId?: string;
  /** pi-agent-core: inspect/replace OpenAI chat.completions body before send */
  onPayload?: (payload: unknown, model?: unknown) => unknown;
  /** pi-agent-core: HTTP status after response headers */
  onResponse?: (
    response: { status: number; headers: Record<string, string> },
    model?: unknown,
  ) => void;
  /** Per-run hooks (mutated around each prompt; cleared after). */
  beforeToolCall?: (
    context: {
      toolCall: { name?: string; id?: string };
      args: unknown;
    },
    signal?: AbortSignal,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
  afterToolCall?: (
    context: {
      toolCall: { name?: string; id?: string };
      args: unknown;
      isError: boolean;
      result: unknown;
    },
    signal?: AbortSignal,
  ) => Promise<
    | {
        content?: unknown;
        details?: unknown;
        isError?: boolean;
        terminate?: boolean;
      }
    | undefined
  >;
  /**
   * pi-agent-core: prune/compact AgentMessage[] before each LLM convertToLlm.
   * Wired at createAgent for mid-run context budget (after tool results).
   */
  transformContext?: (
    messages: Array<{ role: string; content?: unknown }>,
    signal?: AbortSignal,
  ) => Promise<Array<{ role: string; content?: unknown }>>;
};

export type AgentPoolEvent = {
  type: string;
  toolName?: string;
  isError?: boolean;
  result?: unknown;
  message?: unknown;
  assistantMessageEvent?: { type: string; delta?: string };
  messages?: unknown[];
};

export type AgentSession = {
  conversationId: string;
  userId: string;
  agent: PooledAgent;
  lastUsedAt: number;
  busy: boolean;
};

export type CreateAgentFn = (args: {
  conversationId: string;
  userId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}) => Promise<PooledAgent>;

@Injectable()
export class AgentSessionPool implements OnModuleDestroy {
  private readonly logger = new Logger(AgentSessionPool.name);
  private readonly sessions = new Map<string, AgentSession>();
  /** Per-conversation serial queue: prevent double-create and busy races. */
  private readonly tails = new Map<string, Promise<unknown>>();

  private get maxSessions(): number {
    const n = Number(process.env.AGENT_POOL_MAX || 100);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
  }

  private get ttlMs(): number {
    const n = Number(process.env.AGENT_SESSION_TTL_MS || 1_800_000);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1_800_000;
  }

  private get promptWaitMs(): number {
    const n = Number(process.env.AGENT_PROMPT_WAIT_MS || 120_000);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120_000;
  }

  onModuleDestroy() {
    for (const id of [...this.sessions.keys()]) {
      this.dispose(id);
    }
    this.tails.clear();
  }

  size(): number {
    return this.sessions.size;
  }

  getMaxSessions(): number {
    return this.maxSessions;
  }

  getTtlMs(): number {
    return this.ttlMs;
  }

  /** Snapshot of live pool sessions for admin monitoring (no agent references). */
  list(): Array<{
    conversationId: string;
    userId: string;
    busy: boolean;
    lastUsedAt: number;
    isStreaming: boolean;
    messageCount: number;
    modelId: string | null;
    modelProvider: string | null;
  }> {
    this.evictExpired();
    return [...this.sessions.values()].map((s) => ({
      conversationId: s.conversationId,
      userId: s.userId,
      busy: s.busy,
      lastUsedAt: s.lastUsedAt,
      isStreaming: Boolean(s.agent.state.isStreaming),
      messageCount: Array.isArray(s.agent.state.messages)
        ? s.agent.state.messages.length
        : 0,
      modelId: s.agent.state.model?.id ?? null,
      modelProvider: s.agent.state.model?.provider ?? null,
    }));
  }

  stats(): {
    size: number;
    maxSessions: number;
    busy: number;
    idle: number;
    ttlMs: number;
  } {
    this.evictExpired();
    let busy = 0;
    for (const s of this.sessions.values()) {
      if (s.busy) busy += 1;
    }
    const size = this.sessions.size;
    return {
      size,
      maxSessions: this.maxSessions,
      busy,
      idle: size - busy,
      ttlMs: this.ttlMs,
    };
  }

  /** Abort an in-flight prompt without disposing the pooled session. */
  abort(conversationId: string): void {
    const s = this.sessions.get(conversationId);
    if (!s) return;
    try {
      if (s.busy || s.agent.state.isStreaming) {
        s.agent.abort();
        this.logger.debug(`Aborted agent session ${conversationId}`);
      }
    } catch {
      /* ignore */
    }
  }

  dispose(conversationId: string): void {
    const s = this.sessions.get(conversationId);
    if (!s) return;
    try {
      if (s.busy) s.agent.abort();
    } catch {
      /* ignore */
    }
    this.sessions.delete(conversationId);
    this.logger.debug(`Disposed agent session ${conversationId}`);
  }

  disposeMany(conversationIds: string[]): number {
    let disposed = 0;
    for (const id of conversationIds) {
      if (!this.sessions.has(id)) continue;
      this.dispose(id);
      disposed += 1;
    }
    return disposed;
  }

  /**
   * Run work on a per-conversation serial queue so concurrent acquire/create
   * cannot race (double createAgent or dual busy=true).
   */
  private enqueue<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(conversationId) ?? Promise.resolve();
    const run = prev.then(
      () => fn(),
      () => fn(),
    );
    // Keep the chain alive regardless of success/failure of this step.
    this.tails.set(
      conversationId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * Acquire a live agent for the conversation (create or reuse).
   * Caller must call `release` when the prompt run finishes.
   *
   * Create + mark busy are serialized per conversationId. After acquire
   * returns, the session stays busy until release (the queue allows the
   * next waiter only after the previous release when waiters re-enter enqueue).
   *
   * Waiters block inside enqueue until the previous holder releases (busy clears).
   */
  async acquire(
    userId: string,
    conversationId: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    createAgent: CreateAgentFn,
  ): Promise<AgentSession> {
    return this.enqueue(conversationId, async () => {
      this.evictExpired();

      let session = this.sessions.get(conversationId);
      if (session && session.userId !== userId) {
        this.logger.warn(
          `userId mismatch for conversation ${conversationId}; disposing session`,
        );
        this.dispose(conversationId);
        session = undefined;
      }

      if (!session) {
        this.ensureCapacity();
        const agent = await createAgent({ conversationId, userId, history });
        session = {
          conversationId,
          userId,
          agent,
          lastUsedAt: Date.now(),
          busy: false,
        };
        this.sessions.set(conversationId, session);
        this.logger.debug(
          `Created agent session ${conversationId} (pool=${this.sessions.size})`,
        );
      }

      // If still busy (previous run has not released yet), wait outside the
      // pure critical section by polling — but only one waiter owns busy after.
      // Because we are inside enqueue, only one acquire body runs at a time;
      // busy should be false unless release was missed. Wait with timeout.
      await this.waitUntilIdle(session);
      session.busy = true;
      session.lastUsedAt = Date.now();
      return session;
    });
  }

  release(conversationId: string): void {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    session.busy = false;
    session.lastUsedAt = Date.now();
  }

  private async waitUntilIdle(session: AgentSession): Promise<void> {
    if (!session.busy) return;
    const deadline = Date.now() + this.promptWaitMs;
    while (session.busy) {
      if (Date.now() > deadline) {
        throw new Error('Agent is busy with another message; try again shortly.');
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (!s.busy && now - s.lastUsedAt > this.ttlMs) {
        this.dispose(id);
      }
    }
  }

  private ensureCapacity(): void {
    if (this.sessions.size < this.maxSessions) return;

    // Evict least-recently-used idle sessions first.
    const idle = [...this.sessions.values()]
      .filter((s) => !s.busy)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    while (this.sessions.size >= this.maxSessions && idle.length) {
      const victim = idle.shift()!;
      this.dispose(victim.conversationId);
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `Agent pool is full (${this.maxSessions} sessions). Try again later.`,
      );
    }
  }
}
