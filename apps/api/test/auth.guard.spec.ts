import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../src/auth/auth.guard';
import type { AuthService } from '../src/auth/auth.service';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

function makeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard CSRF', () => {
  const principal = {
    userId: 'u1',
    username: 'alice',
    role: 'user' as const,
    sessionId: 's1',
    csrfSecret: 'secret-token',
  };

  it('allows GET without CSRF header', async () => {
    const auth = {
      resolveSession: vi.fn().mockResolvedValue(principal),
    } as unknown as AuthService;
    const guard = new AuthGuard(auth);
    const req = {
      method: 'GET',
      cookies: { csb_kb_session: 'raw' },
      headers: {},
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req).toHaveProperty('principal', principal);
  });

  it('rejects POST without CSRF header even if cookie present', async () => {
    const auth = {
      resolveSession: vi.fn().mockResolvedValue(principal),
    } as unknown as AuthService;
    const guard = new AuthGuard(auth);
    const req = {
      method: 'POST',
      cookies: {
        csb_kb_session: 'raw',
        csb_kb_csrf: 'secret-token',
      },
      headers: {},
    };

    try {
      await guard.canActivate(makeContext(req));
      expect.fail('expected forbidden');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    }
  });

  it('allows POST when X-CSRF-Token matches session secret', async () => {
    const auth = {
      resolveSession: vi.fn().mockResolvedValue(principal),
    } as unknown as AuthService;
    const guard = new AuthGuard(auth);
    const req = {
      method: 'POST',
      cookies: { csb_kb_session: 'raw' },
      headers: { 'x-csrf-token': 'secret-token' },
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
  });

  it('rejects unauthenticated requests', async () => {
    const auth = {
      resolveSession: vi.fn().mockResolvedValue(null),
    } as unknown as AuthService;
    const guard = new AuthGuard(auth);
    const req = {
      method: 'GET',
      cookies: {},
      headers: {},
    };

    try {
      await guard.canActivate(makeContext(req));
      expect.fail('expected unauthorized');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    }
  });
});
