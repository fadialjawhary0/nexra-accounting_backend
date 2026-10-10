import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import passportJwt from 'passport-jwt';
import { ACCESS_COOKIE, ACTIVE_ROLE_HEADER } from '../../common/constants.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { AppConfigService } from '../../lib/config/app-config.service.js';
import { AuthContextService } from './auth-context.service.js';

const { ExtractJwt, Strategy } = passportJwt;

const fromCookie = (request: Request): string | null => {
  const value = (request.cookies as Record<string, unknown> | undefined)?.[ACCESS_COOKIE];
  return typeof value === 'string' && value ? value : null;
};

/**
 * Reads the access JWT from the httpOnly cookie, checks its signature and expiry, and then asks the database whether the
 * session behind it is still alive. Whatever `validate` returns becomes `request.user`.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: AppConfigService,
    private readonly context: AuthContextService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([fromCookie]),
      secretOrKey: config.jwt.accessSecret,
      algorithms: ['HS256'],
      ignoreExpiration: false,
      passReqToCallback: true,
    });
  }

  validate(request: Request, payload: { sub?: string; sid?: string }): Promise<AuthenticatedUser> {
    return this.context.authenticate(payload, request.header(ACTIVE_ROLE_HEADER));
  }
}
