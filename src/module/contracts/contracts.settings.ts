import type { SettingDefinitions } from '../../lib/settings/settings.service.js';

export const CONTRACTS_NAMESPACE = 'contracts';

/**
 * Settings → Contracts. The warnings are advice, never a block: each one can be switched off (docs/09 — "always switchable in settings"). The
 * legal numbers behind them (3 contracts, 36 months, 6 months between chains …) live in the code, with the rule they come from.
 */
export const CONTRACTS_DEFINITIONS = {
  warnNonWorkingDays: { type: 'bool', default: true, group: 'warnings' },
  warnProbation: { type: 'bool', default: true, group: 'warnings' },
  warnChain: { type: 'bool', default: true, group: 'warnings' },
  warnOnCall: { type: 'bool', default: true, group: 'warnings' },
  warnLaw2028: { type: 'bool', default: true, group: 'warnings' },
  warnOverlap: { type: 'bool', default: true, group: 'warnings' },
  warnWage: { type: 'bool', default: true, group: 'warnings' },
  /** A contract that is signed also sets the worker's first day and hourly rate (data is entered once). */
  syncWorker: { type: 'bool', default: true, group: 'worker' },
  /** A worker who leaves also ends their open contracts. */
  endContractsWithWorker: { type: 'bool', default: true, group: 'worker' },
  /** "Ends soon" in the list and the counters. */
  expiringDays: { type: 'int', default: 60, min: 7, max: 365, group: 'list' },
} satisfies SettingDefinitions;
