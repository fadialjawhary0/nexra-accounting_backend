import type { Role, User } from '../../generated/prisma/client.js';

export type UserWithRole = User & { role: Role };

export interface UserWorkload {
  /** Active clients the person is responsible for. */
  clients: number;
  /** Yearly tax returns assigned to the person that are not filed yet. */
  openReturns: number;
  openInspections: number;
  openTasks: number;
  total: number;
}

export const EMPTY_WORKLOAD: UserWorkload = { clients: 0, openReturns: 0, openInspections: 0, openTasks: 0, total: 0 };

/** The user as the frontend knows it (no password hash, no 2FA secret). */
export function serializeUser(user: UserWithRole, workload?: UserWorkload) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    title: user.title,
    phone: user.phone,
    roleKey: user.role.key,
    role: { key: user.role.key, name: user.role.name },
    status: user.status,
    twoFactor: user.twoFactorEnabled,
    twoFactorRequired: user.twoFactorRequired,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    mustChangePassword: user.mustChangePassword,
    permissionOverrides: user.permissionOverrides,
    lastActiveAt: user.lastActiveAt,
    passwordChangedAt: user.passwordChangedAt,
    invitedAt: user.invitedAt,
    createdAt: user.createdAt,
    ...(workload && { workload }),
  };
}
