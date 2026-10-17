import { plainToInstance, Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUrl, Matches, Max, Min, MinLength, validateSync } from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export enum CookieSameSite {
  Lax = 'lax',
  Strict = 'strict',
  None = 'none',
}

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);
/** `KEY=` in a .env file means "not set". */
const emptyToUndefined = ({ value }: { value: unknown }) => (value === '' ? undefined : value);

/**
 * Every environment variable the backend reads. Validated at boot (`ConfigModule.forRoot({ validate })`), so a missing
 * or malformed value stops the server with a clear message instead of failing later. Feature code never touches
 * `process.env` — it asks AppConfigService.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv) NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number) @IsInt() @Min(1) @Max(65535) PORT: number = 4000;

  /** postgresql://user:password@localhost:5432/nexra?schema=public */
  @IsString() @MinLength(1) DATABASE_URL!: string;

  /** Where the Next.js app lives (links in e-mails). */
  @IsUrl({ require_tld: false }) FRONTEND_URL: string = 'http://localhost:3000';

  /** Proxies in front of the API (Vercel → Render = 1) so `req.ip` is the visitor, not the proxy. */
  @Type(() => Number) @IsInt() @Min(0) @Max(5) TRUST_PROXY_HOPS: number = 0;

  /** Signs the access tokens. How long they live (and how long a session lasts) is set in Settings → Security, not here. */
  @IsString() @MinLength(32) JWT_ACCESS_SECRET!: string;

  @IsOptional() @Transform(emptyToUndefined) @IsString() COOKIE_DOMAIN?: string;
  @Transform(toBoolean) @IsBoolean() COOKIE_SECURE: boolean = false;
  @IsEnum(CookieSameSite) COOKIE_SAMESITE: CookieSameSite = CookieSameSite.Lax;

  /** Folder for uploaded files (local disk driver). */
  @IsString() @MinLength(1) STORAGE_DIR: string = './storage';

  /** LibreOffice's `soffice` program, which turns Word files into PDF. Left empty, the usual install folders (and `soffice` on the PATH) are tried. */
  @IsOptional() @Transform(emptyToUndefined) @IsString() LIBREOFFICE_PATH?: string;

  /** Leave SMTP_HOST empty in development: mails are written to the log instead of being sent. */
  @IsOptional() @Transform(emptyToUndefined) @IsString() SMTP_HOST?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(65535) SMTP_PORT: number = 587;
  @Transform(toBoolean) @IsBoolean() SMTP_SECURE: boolean = false;
  @IsOptional() @Transform(emptyToUndefined) @IsString() SMTP_USER?: string;
  @IsOptional() @Transform(emptyToUndefined) @IsString() SMTP_PASS?: string;
  @IsString() MAIL_FROM: string = 'Nexra B.V. <no-reply@nexrabv.nl>';

  /** The OpenAI key that reads photos and PDFs (Phase 11). Left empty, every AI feature says "not set up" and the rest of the app works as before. Never leaves the server. */
  @IsOptional() @Transform(emptyToUndefined) @IsString() OPENAI_API_KEY?: string;
  /** Only to send the AI calls through a proxy or a stand-in server; leave it out to use OpenAI itself. */
  @IsOptional() @Transform(emptyToUndefined) @IsUrl({ require_tld: false }) OPENAI_BASE_URL?: string;

  /** 32 random bytes, base64 — encrypts 2FA secrets and restricted personal data. Generate: openssl rand -base64 32 */
  @Matches(/^[A-Za-z0-9+/]{43}=$/, { message: 'ENCRYPTION_KEY must be 32 random bytes in base64 (44 characters)' }) ENCRYPTION_KEY!: string;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const environment = plainToInstance(EnvironmentVariables, config, { enableImplicitConversion: false });
  const errors = validateSync(environment, { skipMissingProperties: false });
  if (errors.length) {
    const lines = errors.map(error => `  - ${error.property}: ${Object.values(error.constraints ?? {}).join('; ')}`);
    throw new Error(`Invalid environment (backend/.env):\n${lines.join('\n')}`);
  }
  return environment;
}
