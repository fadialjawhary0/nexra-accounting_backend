import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SecuritySettingsService } from '../security-settings/security-settings.service.js';

/** argon2id with the OWASP minimum parameters (19 MiB, 2 passes). */
const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  constructor(
    private readonly security: SecuritySettingsService,
    private readonly prisma: PrismaService,
  ) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Whether `password` is one of the last passwords of this person (the current one counts) — the number is a setting; 0 switches the check off. */
  async reused(userId: string, password: string, currentHash: string | null): Promise<boolean> {
    const keep = this.security.values.passwordHistoryCount;
    if (keep <= 0) return false;
    const earlier = await this.prisma.passwordHistory.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: keep, select: { passwordHash: true } });
    const hashes = [...(currentHash ? [currentHash] : []), ...earlier.map(row => row.passwordHash)];
    for (const hash of hashes) if (await this.verify(hash, password)) return true;
    return false;
  }

  /** Remembers the password that is being replaced, and forgets what is older than the setting asks for. */
  async remember(userId: string, replacedHash: string | null): Promise<void> {
    if (replacedHash) await this.prisma.passwordHistory.create({ data: { userId, passwordHash: replacedHash } });
    const old = await this.prisma.passwordHistory.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, skip: Math.max(this.security.values.passwordHistoryCount, 1), select: { id: true } });
    if (old.length) await this.prisma.passwordHistory.deleteMany({ where: { id: { in: old.map(row => row.id) } } });
  }

  /** Spends the time of a real check, so an unknown e-mail address cannot be told apart by how long the answer takes. */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('timing-equaliser-password');
    await this.verify(await this.dummyHash, password);
  }

  /** The first rule the password breaks, as a translation key (`validation.minLength|{"min":10}`) — or null when it is fine. */
  problem(password: string, person: { email?: string } = {}): string | null {
    const policy = this.security.values;
    if (password.length < policy.passwordMinLength) return `validation.minLength|${JSON.stringify({ min: policy.passwordMinLength })}`;
    if (password.length > 200) return `validation.maxLength|${JSON.stringify({ max: 200 })}`;
    if (policy.passwordRequireLetter && !/\p{L}/u.test(password)) return 'validation.passwordLetter';
    if (policy.passwordRequireNumber && !/\d/.test(password)) return 'validation.passwordNumber';
    if (policy.passwordRequireSymbol && !/[^\p{L}\d\s]/u.test(password)) return 'validation.passwordSymbol';
    const mailName = person.email?.split('@')[0]?.toLowerCase();
    if (mailName && mailName.length >= 4 && password.toLowerCase().includes(mailName)) return 'validation.passwordPersonal';
    return null;
  }

  /** What the "choose a password" screens show next to the input. */
  policy() {
    const policy = this.security.values;
    return {
      minLength: policy.passwordMinLength,
      requireLetter: policy.passwordRequireLetter,
      requireNumber: policy.passwordRequireNumber,
      requireSymbol: policy.passwordRequireSymbol,
      expiryDays: policy.passwordExpiryDays,
    };
  }
}
