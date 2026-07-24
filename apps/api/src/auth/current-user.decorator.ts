import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthPrincipal } from './auth.types';
import { AuthedRequest } from './auth.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return req.principal as AuthPrincipal;
  },
);
