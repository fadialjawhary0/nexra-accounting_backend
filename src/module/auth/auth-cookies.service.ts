import { Injectable } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { ACCESS_COOKIE, REFRESH_COOKIE, SESSION_MARKER_COOKIE } from '../../common/constants.js';
import { AppConfigService } from '../../lib/config/app-config.service.js';
import type { IssuedTokens } from './token.service.js';

/**
 * The three sign-in cookies — all httpOnly, so no script on the page can read them:
 *   nexra_access   the short-lived JWT, sent to every API call
 *   nexra_refresh  the long-lived refresh token, only sent to /api/auth (refresh, logout)
 *   nexra_session  a marker the Next.js proxy looks at to know "somebody is signed in" (it cannot see the other two)
 */
@Injectable()
export class AuthCookiesService {
  constructor(private readonly config: AppConfigService) {}

  set(response: Response, tokens: IssuedTokens): void {
    response.cookie(ACCESS_COOKIE, tokens.accessToken, { ...this.options('/'), maxAge: tokens.accessMaxAgeMs });
    if (tokens.refreshToken) response.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...this.options('/api/auth'), maxAge: tokens.sessionMaxAgeMs });
    response.cookie(SESSION_MARKER_COOKIE, '1', { ...this.options('/'), maxAge: tokens.sessionMaxAgeMs });
  }

  clear(response: Response): void {
    response.clearCookie(ACCESS_COOKIE, this.options('/'));
    response.clearCookie(REFRESH_COOKIE, this.options('/api/auth'));
    response.clearCookie(SESSION_MARKER_COOKIE, this.options('/'));
  }

  refreshTokenOf(request: Request): string | undefined {
    const value = (request.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    return typeof value === 'string' && value ? value : undefined;
  }

  private options(path: string): CookieOptions {
    const { domain, secure, sameSite } = this.config.cookie;
    return { httpOnly: true, secure, sameSite, domain, path };
  }
}
