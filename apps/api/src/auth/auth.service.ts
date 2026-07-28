import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { unauthorized } from '../common/errors';
import { randomToken, sha256Hex } from '../common/crypto';
import { AuthPrincipal } from './auth.types';
import {
  defaultStorageQuotaBytes,
  getUserStorageUsage,
} from '../common/storage-quota';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  sessionTtlMs(): number {
    const days = Number(process.env.SESSION_TTL_DAYS || 7);
    return Math.max(1, days) * 24 * 60 * 60 * 1000;
  }

  async bootstrapAdminIfNeeded() {
    const username = (process.env.ADMIN_USERNAME || '').trim();
    const password = process.env.ADMIN_PASSWORD || '';
    if (!username || !password) return;

    const existing = await this.prisma.user.findUnique({ where: { username } });
    if (existing) return;

    const count = await this.prisma.user.count();
    if (count > 0) return;

    await this.prisma.user.create({
      data: {
        username,
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role: 'admin',
        storageQuotaBytes: BigInt(defaultStorageQuotaBytes()),
      },
    });
    this.logger.log(`Bootstrapped admin user "${username}"`);
  }

  async getStorage(userId: string) {
    return getUserStorageUsage(this.prisma, userId);
  }

  async login(
    username: string,
    password: string,
    meta: { ip?: string; userAgent?: string },
  ) {
    const uname = (username || '').trim();
    const user = await this.prisma.user.findUnique({ where: { username: uname } });
    if (!user || user.disabledAt) throw unauthorized('invalid username or password');
    const ok = await bcrypt.compare(password || '', user.passwordHash);
    if (!ok) throw unauthorized('invalid username or password');

    const rawToken = randomToken(32);
    const csrfSecret = randomToken(16);
    const expiresAt = new Date(Date.now() + this.sessionTtlMs());

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(rawToken),
        csrfSecret,
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });

    return {
      rawToken,
      csrfSecret,
      expiresAt,
      principal: {
        userId: user.id,
        username: user.username,
        role: user.role,
        sessionId: session.id,
        csrfSecret,
      } satisfies AuthPrincipal,
    };
  }

  async logout(rawToken: string | undefined) {
    if (!rawToken) return;
    await this.prisma.session.updateMany({
      where: { tokenHash: sha256Hex(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async resolveSession(rawToken: string | undefined): Promise<AuthPrincipal | null> {
    if (!rawToken) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
      include: { user: true },
    });
    if (!session || session.revokedAt) return null;
    if (session.expiresAt.getTime() < Date.now()) return null;
    if (session.user.disabledAt) return null;
    return {
      userId: session.user.id,
      username: session.user.username,
      role: session.user.role,
      sessionId: session.id,
      csrfSecret: session.csrfSecret,
    };
  }
}
