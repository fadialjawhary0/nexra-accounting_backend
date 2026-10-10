import { ConflictException, Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { CryptoService } from '../../lib/crypto/crypto.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';

const ISSUER = 'Nexra B.V.';
const STEP_SECONDS = 30;
const DIGITS = 6;
/** Codes of the previous and the next 30 seconds are accepted too (clock drift). */
const WINDOW = 1;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.replace(/[\s=]/g, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 one-time password for a counter. */
function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[19]! & 0xf;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export interface TwoFactorSetup {
  /** The secret to type in by hand (grouped in fours). */
  secret: string;
  otpauthUri: string;
  /** PNG data URL of the QR code for the authenticator app. */
  qrDataUrl: string;
}

/** Two-step verification with authenticator apps (TOTP, RFC 6238) and one-time recovery codes. */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** Creates a new secret (stored encrypted, not active yet) and the QR code to scan. */
  async startSetup(user: { id: string; email: string }): Promise<TwoFactorSetup> {
    const secret = base32Encode(randomBytes(20));
    await this.prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: this.crypto.encrypt(secret), twoFactorEnabled: false, twoFactorLastStep: null } });
    const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(user.email)}`;
    const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
    const qrDataUrl = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 224, errorCorrectionLevel: 'M' });
    return { secret: secret.match(/.{1,4}/g)!.join(' '), otpauthUri, qrDataUrl };
  }

  /** Checks the first code from the app, switches two-step verification on and returns the recovery codes (shown once). */
  async confirmSetup(userId: string, code: string): Promise<string[]> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorSecret) throw new ConflictException({ code: 'two_factor_not_started', message: 'Start the setup first' });
    const step = this.matchStep(this.crypto.decrypt(user.twoFactorSecret), code, null);
    // A field error, not a 401: the person is signed in, they just mistyped the code (a 401 would look like an expired session).
    if (step === null) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'That code is not correct', fields: { code: 'validation.invalidCode' } });
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true, twoFactorLastStep: step } });
    return this.regenerateRecoveryCodes(userId);
  }

  /** Verifies a code from the app — or burns a recovery code. Throws `invalid_code` otherwise. */
  async verifyLogin(user: { id: string; twoFactorSecret: string | null; twoFactorLastStep: number | null }, input: { code?: string; recoveryCode?: string }): Promise<void> {
    if (input.recoveryCode) {
      if (await this.consumeRecoveryCode(user.id, input.recoveryCode)) return;
    } else if (input.code && user.twoFactorSecret) {
      const step = this.matchStep(this.crypto.decrypt(user.twoFactorSecret), input.code, user.twoFactorLastStep);
      if (step !== null) {
        await this.prisma.user.update({ where: { id: user.id }, data: { twoFactorLastStep: step } });
        return;
      }
    }
    throw new UnauthorizedException({ code: 'invalid_code', message: 'That code is not correct' });
  }

  async disable(userId: string): Promise<void> {
    await this.prisma.recoveryCode.deleteMany({ where: { userId } });
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorLastStep: null } });
  }

  /** Replaces the recovery codes with ten new ones and returns them (the only time they are visible). */
  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.recoveryCode.createMany({ data: codes.map(code => ({ userId, codeHash: this.crypto.sha256(this.normalizeRecovery(code)) })) }),
    ]);
    return codes;
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const result = await this.prisma.recoveryCode.updateMany({ where: { userId, codeHash: this.crypto.sha256(this.normalizeRecovery(code)), usedAt: null }, data: { usedAt: new Date() } });
    return result.count === 1;
  }

  private normalizeRecovery(code: string): string {
    return code.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /** The time step a code belongs to, or null. Steps at or before `lastStep` are refused, so a code cannot be used twice. */
  private matchStep(secretBase32: string, code: string, lastStep: number | null): number | null {
    const clean = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(clean)) return null;
    const secret = base32Decode(secretBase32);
    const current = Math.floor(Date.now() / 1000 / STEP_SECONDS);
    for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
      const step = current + offset;
      if (lastStep !== null && step <= lastStep) continue;
      if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(clean))) return step;
    }
    return null;
  }
}
