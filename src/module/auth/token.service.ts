import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../../lib/audit/audit.service.js';
import { AppConfigService } from '../../lib/config/app-config.service.js';
import { CryptoService } from '../../lib/crypto/crypto.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SecuritySettingsService } from '../security-settings/security-settings.service.js';
import { describeDevice } from './device.js';

/** A browser that refreshes in parallel (two tabs) may present the token the other tab just replaced; allow it this long. */
const REUSE_GRACE_MS = 20_000;
/** Old, used refresh tokens are kept this long (so reuse can still be recognised), then deleted. */
const KEEP_USED_TOKENS_MS = 24 * 60 * 60 * 1000;

export interface IssuedTokens {
  accessToken: string;
  /** Absent when only the access token was renewed (the browser already holds the newer refresh token). */
  refreshToken?: string;
  sessionId: string;
  accessMaxAgeMs: number;
  /** Time left of the whole session — the lifetime of the refresh and marker cookies. */
  sessionMaxAgeMs: number;
}

export interface RequestMeta {
  ip: string;
  userAgent?: string;
}

interface ChallengePayload {
  sub: string;
  purpose: 'two_factor';
}

/** JWT access tokens, rotating refresh tokens and the sessions behind them. */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly crypto: CryptoService,
    private readonly security: SecuritySettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Starts a session (one device) and returns its first token pair. */
  async startSession(userId: string, meta: RequestMeta): Promise<IssuedTokens> {
    const policy = this.security.values;
    const expiresAt = new Date(Date.now() + policy.sessionMaxDays * 86_400_000);
    const { device, kind } = describeDevice(meta.userAgent);
    const session = await this.prisma.session.create({ data: { userId, expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300), device, kind } });
    return this.issue(userId, session.id, expiresAt, true);
  }

  /**
   * Exchanges a refresh token for a new pair. Reusing a token that was already exchanged revokes the whole session
   * (somebody copied it) — unless it happened within a few seconds, which is just a second tab: then only the access
   * token is renewed.
   */
  async refresh(rawToken: string, meta: RequestMeta): Promise<IssuedTokens> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.crypto.sha256(rawToken) },
      include: { session: { include: { user: { select: { id: true, status: true } } } } },
    });
    const session = stored?.session;
    if (!stored || !session) throw new UnauthorizedException({ code: 'unauthorized', message: 'Sign in again' });
    this.assertSessionUsable(session);
    if (session.user.status !== 'active') throw new UnauthorizedException({ code: 'unauthorized', message: 'Sign in again' });

    if (stored.usedAt) {
      if (Date.now() - stored.usedAt.getTime() <= REUSE_GRACE_MS) return this.issue(session.userId, session.id, session.expiresAt, false);
      await this.revokeSession(session.id, 'refresh_token_reuse');
      await this.audit.log({
        action: 'session_revoked',
        entityType: 'session',
        entityId: session.id,
        entityLabel: session.device,
        actor: { id: session.userId, label: 'unknown' },
        meta: { reason: 'refresh_token_reuse', ip: meta.ip },
      });
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Sign in again' });
    }
    if (stored.expiresAt < new Date()) throw new UnauthorizedException({ code: 'unauthorized', message: 'Sign in again' });

    // Mark it used first; if another request got there between our read and this update, treat it as the grace case.
    const claimed = await this.prisma.refreshToken.updateMany({ where: { id: stored.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count === 0) return this.issue(session.userId, session.id, session.expiresAt, false);
    await this.prisma.refreshToken.deleteMany({ where: { sessionId: session.id, usedAt: { lt: new Date(Date.now() - KEEP_USED_TOKENS_MS) } } });
    await this.prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date(), ip: meta.ip } });
    return this.issue(session.userId, session.id, session.expiresAt, true);
  }

  /** A short-lived ticket between the password step and the second step (the code from the app). */
  signChallenge(userId: string): Promise<string> {
    return this.jwt.signAsync({ sub: userId, purpose: 'two_factor' } satisfies ChallengePayload, { secret: this.config.jwt.accessSecret, expiresIn: '5m' });
  }

  /** The person a valid challenge belongs to. */
  async verifyChallenge(token: string): Promise<string> {
    try {
      const payload = await this.jwt.verifyAsync<ChallengePayload>(token, { secret: this.config.jwt.accessSecret });
      if (payload.purpose !== 'two_factor') throw new Error('wrong purpose');
      return payload.sub;
    } catch {
      throw new UnauthorizedException({ code: 'challenge_expired', message: 'This sign-in step has expired. Start again.' });
    }
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  }

  /** Signing out: ends the session a refresh token belongs to. Returns who it was (for the audit trail), or null for an unknown token. */
  async revokeByRefreshToken(rawToken: string, reason: string): Promise<{ sessionId: string; user: { id: string; name: string } } | null> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.crypto.sha256(rawToken) },
      include: { session: { include: { user: { select: { id: true, name: true } } } } },
    });
    if (!stored) return null;
    await this.revokeSession(stored.sessionId, reason);
    return { sessionId: stored.sessionId, user: stored.session.user };
  }

  /** Ends every session of a person (optionally keeping one). Returns how many were ended. */
  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId && { id: { not: exceptSessionId } }) },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  /** Throws when the session was ended, ran out, or sat idle for too long (ending it in the last case). */
  assertSessionUsable(session: { id: string; revokedAt: Date | null; expiresAt: Date; lastUsedAt: Date }): void {
    const now = Date.now();
    if (session.revokedAt || session.expiresAt.getTime() <= now) throw new UnauthorizedException({ code: 'unauthorized', message: 'Sign in again' });
    if (now - session.lastUsedAt.getTime() > this.security.values.sessionIdleMinutes * 60_000) {
      void this.revokeSession(session.id, 'idle');
      throw new UnauthorizedException({ code: 'session_idle', message: 'You were signed out because of inactivity' });
    }
  }

  private async issue(userId: string, sessionId: string, sessionExpiresAt: Date, rotate: boolean): Promise<IssuedTokens> {
    const accessMinutes = this.security.values.sessionAccessMinutes;
    const accessToken = await this.jwt.signAsync({ sub: userId, sid: sessionId }, { secret: this.config.jwt.accessSecret, expiresIn: accessMinutes * 60 });
    const sessionMaxAgeMs = Math.max(sessionExpiresAt.getTime() - Date.now(), 0);
    let refreshToken: string | undefined;
    if (rotate) {
      refreshToken = this.crypto.randomToken(48);
      await this.prisma.refreshToken.create({ data: { sessionId, tokenHash: this.crypto.sha256(refreshToken), expiresAt: sessionExpiresAt } });
    }
    return { accessToken, refreshToken, sessionId, accessMaxAgeMs: accessMinutes * 60_000, sessionMaxAgeMs };
  }
}
