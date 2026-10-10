import type { PermissionMatrix } from '../../module/roles/permission-catalog.js';

/** What a signed-in person must do before anything else. */
export type AccountRestriction = 'password' | 'two_factor';

/** The signed-in user as the auth guard puts it on `request.user`. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  /** The role this request acts as — the previewed one while the owner previews. */
  roleKey: string;
  roleName: string;
  /** The person's own role (differs from `roleKey` only while previewing). */
  actualRoleKey: string;
  /** What this request may do: the role's matrix with the person's overrides — or the previewed role (owner only). */
  matrix: PermissionMatrix;
  /** The owner is looking at the app as another role (X-Active-Role). */
  previewing: boolean;
  sessionId: string;
  /** Only the routes marked `@AllowWhileRestricted()` work until this is cleared. */
  restriction: AccountRestriction | null;
}
