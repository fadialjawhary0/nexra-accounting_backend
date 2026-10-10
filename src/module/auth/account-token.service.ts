import { Injectable } from '@nestjs/common';
import { CryptoService } from '../../lib/crypto/crypto.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { AuthTokenType } from '../../generated/prisma/client.js';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

/** The links in invitation and password-reset e-mails. Only a hash of the token is stored; each link works once. */
@Injectable()
export class AccountTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** A fresh token; links sent earlier of the same kind stop working. */
  async issue(userId: string, type: AuthTokenType): Promise<{ token: string; expiresAt: Date }> {
    await this.prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
    const token = this.crypto.randomToken(32);
    const expiresAt = new Date(Date.now() + (type === 'invite' ? INVITE_TTL_MS : RESET_TTL_MS));
    await this.prisma.authToken.create({ data: { userId, type, tokenHash: this.crypto.sha256(token), expiresAt } });
    return { token, expiresAt };
  }

  /** The token row (with its user) while it is unused and not expired; otherwise null. */
  find(rawToken: string, type: AuthTokenType) {
    return this.prisma.authToken.findFirst({
      where: { tokenHash: this.crypto.sha256(rawToken), type, usedAt: null, expiresAt: { gt: new Date() } },
      include: { user: { include: { role: true } } },
    });
  }

  /** Spends the link. False when somebody else (a double click, a second tab) used it a moment earlier. */
  async consume(id: string): Promise<boolean> {
    const result = await this.prisma.authToken.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } });
    return result.count === 1;
  }
}
