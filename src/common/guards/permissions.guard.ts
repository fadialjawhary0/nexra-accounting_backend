import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { matrixAllows } from '../../module/roles/permission-catalog.js';
import { PERMISSIONS_KEY } from '../constants.js';
import type { AuthenticatedUser } from '../types/authenticated-user.js';

/** Checks `@RequirePermission('area.action', …)` against what the signed-in person (or the role they preview) may do. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndMerge<string[]>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
    if (!required.length) return true;
    const user = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>().user;
    if (!user) throw new UnauthorizedException({ code: 'unauthorized', message: 'Sign in again' });
    const missing = required.filter(permission => !matrixAllows(user.matrix, permission));
    if (missing.length) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.', details: { missing } });
    return true;
  }
}
