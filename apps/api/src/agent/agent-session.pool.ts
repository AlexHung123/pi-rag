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
    messages: Array<{ role: string; content?: unknown; errorMessage?: string }>;
    errorMessage?: string;
    isStreaming: boolean;
  };
  sessionId?: string;
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
  }

  size(): number {
    return this.sessions.size;
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

  /**
   * Acquire a live agent for the conversation (create or reuse).
   * Caller must call `release` when the prompt run finishes.
   */
  async acquire(
    userId: string,
    conversationId: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    createAgent: CreateAgentFn,
  ): Promise<AgentSession> {
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

    await this.waitUntilIdle(session);
    session.busy = true;
    session.lastUsedAt = Date.now();
    return session;
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
