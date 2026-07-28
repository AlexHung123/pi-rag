import { describe, expect, it, vi } from 'vitest';
import {
  AgentSessionPool,
  type CreateAgentFn,
  type PooledAgent,
} from '../src/agent/agent-session.pool';

function fakeAgent(): PooledAgent {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    state: {
      messages: [],
      isStreaming: false,
    },
  };
}

describe('AgentSessionPool concurrency', () => {
  it('creates only one agent for concurrent first acquires', async () => {
    const pool = new AgentSessionPool();
    let creates = 0;
    const createAgent: CreateAgentFn = async () => {
      creates += 1;
      await new Promise((r) => setTimeout(r, 40));
      return fakeAgent();
    };

    const first = pool.acquire('user-1', 'conv-1', [], createAgent).then(async (s) => {
      // Hold briefly, then release so the second waiter can proceed.
      await new Promise((r) => setTimeout(r, 30));
      pool.release('conv-1');
      return s;
    });
    const second = pool.acquire('user-1', 'conv-1', [], createAgent);

    const [a, b] = await Promise.all([first, second]);
    expect(creates).toBe(1);
    expect(a.agent).toBe(b.agent);
    expect(pool.size()).toBe(1);
    pool.release('conv-1');
    pool.dispose('conv-1');
  });

  it('serializes busy so second acquire waits for release', async () => {
    const pool = new AgentSessionPool();
    const createAgent: CreateAgentFn = async () => fakeAgent();

    const first = await pool.acquire('user-1', 'conv-2', [], createAgent);
    expect(first.busy).toBe(true);

    const secondPromise = pool.acquire('user-1', 'conv-2', [], createAgent);
    await new Promise((r) => setTimeout(r, 20));
    pool.release('conv-2');
    const second = await secondPromise;
    expect(second.busy).toBe(true);
    expect(pool.size()).toBe(1);
    pool.release('conv-2');
    pool.dispose('conv-2');
  });
});
