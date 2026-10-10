import type { ClsStore } from 'nestjs-cls';

/** What the request context (nestjs-cls) carries: the auth guard (Phase 4) sets `actor`, the CLS middleware the rest. */
export interface AppClsStore extends ClsStore {
  actor?: { id: string; label: string };
  ip?: string;
  userAgent?: string;
}
