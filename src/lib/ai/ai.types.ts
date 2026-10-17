/** What the AI is used for — each one has its own switch in Settings → AI and its own line in the usage overview. */
export const AI_FEATURES = ['classify', 'id_document', 'kvk_extract', 'contract', 'staffing_invoice', 'timesheet', 'letter', 'mapping', 'form_fill', 'inspection_request', 'inbox', 'test'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** The features a person can switch off (the connection test always works). */
export const SWITCHABLE_FEATURES = AI_FEATURES.filter(feature => feature !== 'test');

/** `main` reads documents; `light` is the cheaper model that only sorts them. */
export type AiTier = 'main' | 'light';

/** A file that goes along with the question: a photo or scan (read as an image) or a PDF. */
export interface AiInputFile {
  kind: 'image' | 'pdf';
  mime: string;
  name: string;
  data: Buffer;
  /** How closely the file is looked at: `low` is cheap (enough to sort a document), `high` reads small print. Default `high`. */
  detail?: 'low' | 'high' | 'auto';
}

export interface AiExtractRequest {
  feature: AiFeature;
  tier?: AiTier;
  /** What the AI is asked to do and how to answer. */
  instructions: string;
  /** Text that goes along with the files (the text found in a PDF, the headings of a spreadsheet …). */
  text?: string;
  files?: AiInputFile[];
  /** The answer must fit this JSON schema (strict: every property is required, extras are not allowed). */
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  /** For the usage overview: the import item and the person it was done for. */
  itemId?: string | null;
  userId?: string | null;
  signal?: AbortSignal;
}

export interface AiExtractResult<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** An estimate in US dollars, from the model's price. */
  costUsd: number;
}

export type AiBudgetLevel = 'ok' | 'warning' | 'exceeded';

export interface AiBudgetStatus {
  /** 0 = no limit. */
  limitUsd: number;
  spentUsd: number;
  /** Null when there is no limit. */
  percent: number | null;
  warnAtPercent: number;
  level: AiBudgetLevel;
  /** The month the spend is counted for (`2026-10`). */
  month: string;
}

export interface AiStatus {
  /** There is a key in the environment. */
  configured: boolean;
  /** The master switch in Settings → AI is on. */
  enabled: boolean;
  /** The key is set and the switch is on. */
  available: boolean;
  /** The calls go to another address than OpenAI's (a proxy or a stand-in). */
  customEndpoint: boolean;
  model: string;
  classifyModel: string;
  budget: AiBudgetStatus;
  features: Record<string, boolean>;
  confidenceThreshold: number;
  concurrency: number;
  maxFileMb: number;
}

export type AiErrorCode =
  | 'ai_not_configured'
  | 'ai_disabled'
  | 'ai_feature_off'
  | 'ai_budget_exceeded'
  | 'ai_key_invalid'
  | 'ai_model_unknown'
  | 'ai_quota'
  | 'ai_rate_limited'
  | 'ai_unreachable'
  | 'ai_request_rejected'
  | 'ai_refused'
  | 'ai_incomplete'
  | 'ai_invalid_output'
  | 'ai_failed';

/** Something the AI could not do: `code` says what (it is also the translation key of the message shown in the review list), `retryable` whether a new try may help. */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    readonly retryable: boolean,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AiError';
  }
}

export interface AiTestResult {
  model: string;
  tier: AiTier;
  ok: boolean;
  /** The error code when it failed. */
  code?: AiErrorCode;
  detail?: string;
  durationMs: number;
}
