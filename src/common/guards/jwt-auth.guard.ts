import { type ExecutionContext, ForbiddenException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { ALLOW_RESTRICTED_KEY, IS_PUBLIC_KEY } from '../constants.js';
import type { AppClsStore } from '../../lib/audit/cls-store.js';
import type { AuthenticatedUser } from '../types/authenticated-user.js';

/**
 * The global sign-in check: every route needs a valid session unless it is marked `@Public()`. A person who still has to
 * choose a new password (or set up two-step verification) may only reach the routes marked `@AllowWhileRestricted()`.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<AppClsStore>,
  ) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    await super.canActivate(context); // throws 401 for a missing / invalid token or an ended session
    const user = context.switchToHttp().getRequest<Request & { user: AuthenticatedUser }>().user;

    if (user.restriction && !this.reflector.getAllAndOverride<boolean>(ALLOW_RESTRICTED_KEY, targets)) {
      throw new ForbiddenException(
        user.restriction === 'password'
          ? { code: 'password_change_required', message: 'Choose a new password first.' }
          : { code: 'two_factor_setup_required', message: 'Set up two-step verification first.' },
      );
    }
    this.cls.set('actor', { id: user.id, label: user.name });
    return true;
  }

  override handleRequest<TUser = AuthenticatedUser>(error: unknown, user: TUser | false): TUser {
    if (error instanceof HttpException) throw error;
    if (error || !user) throw new UnauthorizedException({ code: 'unauthorized', message: 'Sign in again' });
    return user;
  }
}
