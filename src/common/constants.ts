/** Metadata keys read by the guards. */
export const IS_PUBLIC_KEY = 'nexra:isPublic';
export const PERMISSIONS_KEY = 'nexra:permissions';
/** Routes that stay reachable while the account is restricted (must choose a new password / must set up two-step verification). */
export const ALLOW_RESTRICTED_KEY = 'nexra:allowRestricted';
/** Routes that get the strict sign-in rate limit. */
export const AUTH_THROTTLE_KEY = 'nexra:authThrottle';

/** Cookie names. The marker cookie is what the Next.js proxy looks at (it cannot see the API-only cookies). */
export const ACCESS_COOKIE = 'nexra_access';
export const REFRESH_COOKIE = 'nexra_refresh';
export const SESSION_MARKER_COOKIE = 'nexra_session';

/** The owner previews the app as another role by sending this header (value: the role key). */
export const ACTIVE_ROLE_HEADER = 'x-active-role';
