import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'node:path';
import { NodeEnv, type CookieSameSite, type EnvironmentVariables } from './env.validation.js';

/** Typed access to the validated environment. The only place (besides prisma.config.ts) that knows variable names. */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  get nodeEnv(): NodeEnv {
    return this.config.get('NODE_ENV', { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === NodeEnv.Production;
  }

  get port(): number {
    return this.config.get('PORT', { infer: true });
  }

  get databaseUrl(): string {
    return this.config.get('DATABASE_URL', { infer: true });
  }

  get frontendUrl(): string {
    return this.config.get('FRONTEND_URL', { infer: true }).replace(/\/+$/, '');
  }

  get trustProxyHops(): number {
    return this.config.get('TRUST_PROXY_HOPS', { infer: true });
  }

  get jwt() {
    return { accessSecret: this.config.get('JWT_ACCESS_SECRET', { infer: true }) };
  }

  get cookie(): { domain: string | undefined; secure: boolean; sameSite: CookieSameSite } {
    return {
      domain: this.config.get('COOKIE_DOMAIN', { infer: true }),
      secure: this.config.get('COOKIE_SECURE', { infer: true }),
      sameSite: this.config.get('COOKIE_SAMESITE', { infer: true }),
    };
  }

  /** Absolute folder for uploads. */
  get storageDir(): string {
    return path.resolve(this.config.get('STORAGE_DIR', { infer: true }));
  }

  /** SMTP settings, or `null` when no server is configured (development: mails go to the log). */
  get smtp() {
    const host = this.config.get('SMTP_HOST', { infer: true });
    if (!host) return null;
    const user = this.config.get('SMTP_USER', { infer: true });
    return {
      host,
      port: this.config.get('SMTP_PORT', { infer: true }),
      secure: this.config.get('SMTP_SECURE', { infer: true }),
      auth: user ? { user, pass: this.config.get('SMTP_PASS', { infer: true }) ?? '' } : undefined,
    };
  }

  get mailFrom(): string {
    return this.config.get('MAIL_FROM', { infer: true });
  }

  /** The 32-byte key behind CryptoService. */
  get encryptionKey(): Buffer {
    return Buffer.from(this.config.get('ENCRYPTION_KEY', { infer: true }), 'base64');
  }
}
