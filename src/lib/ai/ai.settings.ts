import type { SettingDefinitions } from '../settings/settings.service.js';

export const AI_NAMESPACE = 'ai';

/** How hard a model thinks before answering: less is faster and cheaper, more is more careful. */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const;

/**
 * Settings → AI. Every number has a sensible default and can be changed by the office. The model names are free text on purpose: the provider
 * renames and replaces models, and the connection test in the same screen tells whether a name works. Switching a feature off makes the import
 * file those documents by their folder and file names only.
 */
export const AI_DEFINITIONS = {
  enabled: { type: 'bool', default: true, group: 'general' },
  model: { type: 'string', default: 'gpt-6.1-sol', required: true, maxLength: 80, group: 'models' },
  classifyModel: { type: 'string', default: 'gpt-6-luna', required: true, maxLength: 80, group: 'models' },
  reasoningEffort: { type: 'enum', default: 'low', options: REASONING_EFFORTS, group: 'models' },
  /** Dollars per month the AI may cost; 0 = no limit. Reaching it stops the AI calls until the next month or a higher budget. */
  monthlyBudgetUsd: { type: 'int', default: 25, min: 0, max: 100_000, group: 'budget' },
  budgetWarnPercent: { type: 'int', default: 80, min: 1, max: 100, group: 'budget' },
  /** Values the AI is less sure of than this (percent) are highlighted in the review list, and "accept all" leaves those files alone. */
  confidenceThreshold: { type: 'int', default: 85, min: 50, max: 100, group: 'review' },
  /** How many files are read at the same time. */
  concurrency: { type: 'int', default: 3, min: 1, max: 10, group: 'speed' },
  /** Bigger files are not sent to the AI (they are filed by folder and file name). */
  maxFileMb: { type: 'int', default: 15, min: 1, max: 50, group: 'speed' },
  featureClassify: { type: 'bool', default: true, group: 'features' },
  featureIdDocument: { type: 'bool', default: true, group: 'features' },
  featureKvkExtract: { type: 'bool', default: true, group: 'features' },
  featureContract: { type: 'bool', default: true, group: 'features' },
  featureStaffingInvoice: { type: 'bool', default: true, group: 'features' },
  featureTimesheet: { type: 'bool', default: true, group: 'features' },
  featureLetter: { type: 'bool', default: true, group: 'features' },
  featureMapping: { type: 'bool', default: true, group: 'features' },
  featureFormFill: { type: 'bool', default: true, group: 'features' },
  featureInspectionRequest: { type: 'bool', default: true, group: 'features' },
  /** The AI inbox of the dashboard: a message in a person's own words becomes tasks, appointments, workers … to confirm. */
  featureInbox: { type: 'bool', default: true, group: 'features' },
  /** US cents per million tokens, only for a model that is not in the built-in price list (0 = use the price of the main model). */
  priceInputCents: { type: 'int', default: 0, min: 0, max: 1_000_000, group: 'prices' },
  priceOutputCents: { type: 'int', default: 0, min: 0, max: 1_000_000, group: 'prices' },
} satisfies SettingDefinitions;

/** The settings key of a feature's switch. */
export const FEATURE_SETTING: Record<string, keyof typeof AI_DEFINITIONS | null> = {
  classify: 'featureClassify',
  id_document: 'featureIdDocument',
  kvk_extract: 'featureKvkExtract',
  contract: 'featureContract',
  staffing_invoice: 'featureStaffingInvoice',
  timesheet: 'featureTimesheet',
  letter: 'featureLetter',
  mapping: 'featureMapping',
  form_fill: 'featureFormFill',
  inspection_request: 'featureInspectionRequest',
  inbox: 'featureInbox',
  test: null,
};
