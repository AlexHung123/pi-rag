import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto';
import { AuthGuard, AuthedRequest } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthPrincipal, CSRF_COOKIE, SESSION_COOKIE } from './auth.types';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private setSessionCookies(
    res: Response,
    rawToken: string,
    csrfSecret: string,
    expiresAt: Date,
  ) {
    const secure = (process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true';
    const common = {
      httpOnly: true as const,
      sameSite: 'lax' as const,
      secure,
      expires: expiresAt,
      path: '/',
    };
    res.cookie(SESSION_COOKIE, rawToken, { ...common, httpOnly: true });
    // CSRF cookie readable by JS for double-submit
    res.cookie(CSRF_COOKIE, csrfSecret, {
      ...common,
      httpOnly: false,
    });
  }

  private clearCookies(res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  @Get('bootstrap')
  bootstrap() {
    return {
      authEnabled: true,
    };
  }

  @Post('login')
  async login(
    @Body() body: LoginDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.login(body.username, body.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setSessionCookies(res, session.rawToken, session.csrfSecret, session.expiresAt);
    return {
      user: {
        id: session.principal.userId,
        username: session.principal.username,
        role: session.principal.role,
      },
      csrfToken: session.csrfSecret,
    };
  }

  @Post('logout')
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE]);
    this.clearCookies(res);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(
    @CurrentUser() user: AuthPrincipal,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Refresh readable CSRF cookie so SPA can always sync after reload.
    const secure = (process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true';
    res.cookie(CSRF_COOKIE, user.csrfSecret, {
      httpOnly: false,
      sameSite: 'lax',
      secure,
      path: '/',
    });
    return {
      user: {
        id: user.userId,
        username: user.username,
        role: user.role,
      },
      csrfToken: user.csrfSecret,
    };
  }

  /** Current user's total document storage usage vs quota. */
  @Get('me/storage')
  @UseGuards(AuthGuard)
  storage(@CurrentUser() user: AuthPrincipal) {
    return this.auth.getStorage(user.userId);
  }
}
