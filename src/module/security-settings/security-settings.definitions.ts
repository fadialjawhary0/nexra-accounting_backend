import type { SettingDefinitions } from '../../lib/settings/settings.service.js';

export const SECURITY_NAMESPACE = 'security';

/**
 * Everything Ahmad can tune about security — with a default, and a minimum / maximum that cannot be crossed (so nobody can
 * switch protection off, or lock the office out). The code reads these through SecuritySettingsService; nothing here is a
 * constant in the guards.
 */
export const SECURITY_DEFINITIONS = {
  // Sign-in lockout (kept in the database; per account + IP and per IP, growing delays)
  loginMaxFailures: { type: 'int', default: 5, min: 3, max: 20, group: 'login' },
  loginLockBaseMinutes: { type: 'int', default: 1, min: 1, max: 60, group: 'login' },
  loginLockMaxMinutes: { type: 'int', default: 30, min: 5, max: 1440, group: 'login' },
  // Request limits
  rateRequestsPerMinute: { type: 'int', default: 300, min: 60, max: 3000, group: 'rate' },
  rateAuthPerMinute: { type: 'int', default: 10, min: 3, max: 60, group: 'rate' },
  /** Files one person may upload per hour, and AI questions the whole office may ask per hour (a runaway import cannot run up the bill). */
  uploadsPerHour: { type: 'int', default: 300, min: 30, max: 5000, group: 'rate' },
  aiRequestsPerHour: { type: 'int', default: 500, min: 20, max: 20000, group: 'rate' },
  // Session lengths
  sessionAccessMinutes: { type: 'int', default: 15, min: 5, max: 60, group: 'session' },
  sessionMaxDays: { type: 'int', default: 30, min: 1, max: 90, group: 'session' },
  sessionIdleMinutes: { type: 'int', default: 720, min: 15, max: 43200, group: 'session' },
  // Password policy
  passwordMinLength: { type: 'int', default: 10, min: 8, max: 64, group: 'password' },
  passwordRequireLetter: { type: 'bool', default: true, group: 'password' },
  passwordRequireNumber: { type: 'bool', default: true, group: 'password' },
  passwordRequireSymbol: { type: 'bool', default: false, group: 'password' },
  /** 0 = passwords never expire. */
  passwordExpiryDays: { type: 'int', default: 0, min: 0, max: 365, group: 'password' },
  /** How many earlier passwords cannot be chosen again (0 = no check). */
  passwordHistoryCount: { type: 'int', default: 3, min: 0, max: 24, group: 'password' },
  // Two-step verification
  twoFactorRequireForEveryone: { type: 'bool', default: false, group: 'twoFactor' },
  // Uploads
  uploadMaxMegabytes: { type: 'int', default: 25, min: 1, max: 200, group: 'upload' },
  /** Which kinds of file may be uploaded (PDF is always allowed): pictures, Word / Excel / PowerPoint / OpenDocument, e-mail messages, text and CSV. */
  uploadAllowImages: { type: 'bool', default: true, group: 'upload' },
  uploadAllowOffice: { type: 'bool', default: true, group: 'upload' },
  uploadAllowEmail: { type: 'bool', default: true, group: 'upload' },
  uploadAllowText: { type: 'bool', default: true, group: 'upload' },
  // Retention
  /** Months the activity log is kept (0 = for ever; otherwise at least 12). Older entries are removed every night. */
  auditRetentionMonths: { type: 'int', default: 0, min: 0, max: 120, group: 'retention' },
} satisfies SettingDefinitions;

export type SecurityValues = { [K in keyof typeof SECURITY_DEFINITIONS]: (typeof SECURITY_DEFINITIONS)[K]['type'] extends 'bool' ? boolean : number };
