import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../types/authenticated-user.js';

/**
 * The signed-in user (or one property of it) in a controller method.
 *   create(@CurrentUser() user: AuthenticatedUser)      create(@CurrentUser('id') userId: string)
 */
export const CurrentUser = createParamDecorator((property: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
  const user = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>().user;
  return property ? user?.[property] : user;
});
