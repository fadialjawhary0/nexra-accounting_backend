import { SetMetadata } from '@nestjs/common';
import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY } from '../constants.js';

/**
 * The permission(s) a route needs — all of them. Checked by the PermissionsGuard (Phase 4).
 *   @RequirePermission('contracts.edit')
 */
export const RequirePermission = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * The route needs at least ONE of these permissions (`@RequirePermission` needs all of them).
 *   @RequireAnyPermission('clients.view', 'employees.view')
 */
export const RequireAnyPermission = (...permissions: string[]) => SetMetadata(ANY_PERMISSIONS_KEY, permissions);
