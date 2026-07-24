import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { forbidden, unauthorized } from '../common/errors';
import { AuthPrincipal, CSRF_COOKIE, SESSION_COOKIE } from './auth.types';

export type AuthedRequest = Request & {
  principal?: AuthPrincipal;
  cookies: Record<string, string>;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const rawToken = req.cookies?.[SESSION_COOKIE];
    const principal = await this.auth.resolveSession(rawToken);
    if (!principal) throw unauthorized();

    const method = (req.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const headerToken =
        (req.headers['x-csrf-token'] as string | undefined) ||
        (req.headers['x-xsrf-token'] as string | undefined) ||
        '';
      const cookieToken = req.cookies?.[CSRF_COOKIE] || '';
      if (!headerToken || headerToken !== cookieToken || headerToken !== principal.csrfSecret) {
        throw forbidden('invalid csrf token');
      }
    }

    req.principal = principal;
    return true;
  }
}
