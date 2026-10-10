import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service.js';

const VERSION = 'v1';

/**
 * Small crypto helpers used by auth and the restricted-data columns:
 *   - encrypt / decrypt   AES-256-GCM with the ENCRYPTION_KEY (2FA secrets, BSN, IBAN)
 *   - sha256              fingerprints of tokens we store (refresh, reset, invite) — never the token itself
 *   - blindIndex          keyed hash of a restricted value (BSN, IBAN …): equal values give equal hashes, so duplicates can be found without storing the value
 *   - randomToken         unguessable URL-safe tokens
 */
@Injectable()
export class CryptoService {
  constructor(private readonly config: AppConfigService) {}

  /** `v1:<iv>:<auth tag>:<cipher text>` (base64 parts). */
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, encrypted] = payload.split(':');
    if (version !== VERSION || !iv || !tag || !encrypted) throw new Error('Unsupported encrypted value');
    const decipher = createDecipheriv('aes-256-gcm', this.config.encryptionKey, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
  }

  sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /** HMAC-SHA256 under a key derived from the encryption key (so a leaked hash cannot be brute-forced without it). */
  blindIndex(value: string): string {
    const key = createHmac('sha256', this.config.encryptionKey).update('nexra:blind-index:v1').digest();
    return createHmac('sha256', key).update(value).digest('hex');
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Constant-time comparison of two strings. */
  safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
