import { SetMetadata } from '@nestjs/common';
import { PERMISSIONS_KEY } from '../constants.js';

/**
 * The permission(s) a route needs — all of them. Checked by the PermissionsGuard (Phase 4).
 *   @RequirePermission('contracts.edit')
 */
export const RequirePermission = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);
