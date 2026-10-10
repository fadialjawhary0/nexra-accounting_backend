import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { matrixAllows } from '../../module/roles/permission-catalog.js';
import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY } from '../constants.js';
import type { AuthenticatedUser } from '../types/authenticated-user.js';

/** Checks `@RequirePermission('area.action', …)` against what the signed-in person (or the role they preview) may do. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndMerge<string[]>(PERMISSIONS_KEY, targets);
    const anyOf = this.reflector.getAllAndOverride<string[] | undefined>(ANY_PERMISSIONS_KEY, targets) ?? [];
    if (!required.length && !anyOf.length) return true;
    const user = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>().user;
    if (!user) throw new UnauthorizedException({ code: 'unauthorized', message: 'Sign in again' });
    const missing = required.filter(permission => !matrixAllows(user.matrix, permission));
    if (missing.length) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.', details: { missing } });
    if (anyOf.length && !anyOf.some(permission => matrixAllows(user.matrix, permission))) {
      throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.', details: { missingAny: anyOf } });
    }
    return true;
  }
}
