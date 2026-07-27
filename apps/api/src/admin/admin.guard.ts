import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { forbidden } from '../common/errors';
import type { AuthedRequest } from '../auth/auth.guard';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const principal = req.principal;
    if (!principal || principal.role !== 'admin') {
      throw forbidden('admin role required');
    }
    return true;
  }
}
