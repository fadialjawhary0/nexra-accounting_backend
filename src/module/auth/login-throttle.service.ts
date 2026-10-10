import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SecuritySettingsService } from '../security-settings/security-settings.service.js';

const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;
/** A whole IP (an office behind one address) gets this many times the failures of one account before it is locked. */
const IP_FACTOR = 3;

/**
 * Sign-in lockout kept in the database, so it survives a restart. Two counters: one per account **and** IP, one per IP.
 * An attacker who keeps guessing Ahmad's password locks only his own address — Ahmad, signing in from his, is untouched.
 * After the allowed number of failures the delay doubles each time, up to the configured maximum.
 */
@Injectable()
export class LoginThrottleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecuritySettingsService,
  ) {}

  /** Throws 429 `too_many_attempts` (with how long to wait) while the account + IP or the IP is locked. */
  async assertAllowed(subject: string, ip: string): Promise<void> {
    const rows = await this.prisma.loginThrottle.findMany({ where: { key: { in: this.keys(subject, ip) }, lockedUntil: { gt: new Date() } } });
    const until = Math.max(0, ...rows.map(row => row.lockedUntil!.getTime()));
    if (until > 0) {
      throw new HttpException(
        { code: 'too_many_attempts', message: 'Too many attempts. Try again later.', details: { retryAfterSeconds: Math.ceil((until - Date.now()) / 1000) } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async recordFailure(subject: string, ip: string): Promise<void> {
    const threshold = this.security.values.loginMaxFailures;
    const [accountKey, ipKey] = this.keys(subject, ip) as [string, string];
    await this.bump(accountKey, threshold);
    await this.bump(ipKey, threshold * IP_FACTOR);
  }

  async recordSuccess(subject: string, ip: string): Promise<void> {
    await this.prisma.loginThrottle.deleteMany({ where: { key: { in: this.keys(subject, ip) } } });
  }

  private keys(subject: string, ip: string): string[] {
    return [`acct:${subject}:${ip}`, `ip:${ip}`];
  }

  private async bump(key: string, threshold: number): Promise<void> {
    const policy = this.security.values;
    const existing = await this.prisma.loginThrottle.findUnique({ where: { key } });
    const stale = existing && Date.now() - existing.updatedAt.getTime() > FORGET_AFTER_MS && !(existing.lockedUntil && existing.lockedUntil.getTime() > Date.now());
    const failures = (stale || !existing ? 0 : existing.failures) + 1;
    let lockedUntil: Date | null = existing?.lockedUntil ?? null;
    if (failures >= threshold) {
      const minutes = Math.min(policy.loginLockBaseMinutes * 2 ** Math.min(failures - threshold, 12), policy.loginLockMaxMinutes);
      lockedUntil = new Date(Date.now() + minutes * 60_000);
    }
    await this.prisma.loginThrottle.upsert({ where: { key }, create: { key, failures, lockedUntil }, update: { failures, lockedUntil } });
  }
}
