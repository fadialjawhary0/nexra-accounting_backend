import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { SecuritySettingsService } from '../security-settings/security-settings.service.js';

/** argon2id with the OWASP minimum parameters (19 MiB, 2 passes). */
const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  constructor(private readonly security: SecuritySettingsService) {}

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
