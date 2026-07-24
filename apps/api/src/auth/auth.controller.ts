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
import { LoginDto, RegisterDto } from './dto';
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
      allowRegister: this.auth.allowRegister(),
      authEnabled: true,
    };
  }

  @Post('register')
  async register(
    @Body() body: RegisterDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.register(body.username, body.password);
    const session = await this.auth.login(user.username, body.password, {
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
  me(@CurrentUser() user: AuthPrincipal) {
    return {
      user: {
        id: user.userId,
        username: user.username,
        role: user.role,
      },
      csrfToken: user.csrfSecret,
    };
  }
}
