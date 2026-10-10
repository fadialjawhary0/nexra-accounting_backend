import { SetMetadata } from '@nestjs/common';
import { ALLOW_RESTRICTED_KEY, AUTH_THROTTLE_KEY } from '../constants.js';

/**
 * Stays reachable while the account is restricted — the person must first choose a new password, or set up two-step
 * verification (`/auth/me`, `/auth/password`, `/auth/two-factor/*`, `/auth/logout`).
 */
export const AllowWhileRestricted = () => SetMetadata(ALLOW_RESTRICTED_KEY, true);

/** Applies the strict sign-in rate limit (per IP) on top of the general one. */
export const AuthThrottle = () => SetMetadata(AUTH_THROTTLE_KEY, true);
