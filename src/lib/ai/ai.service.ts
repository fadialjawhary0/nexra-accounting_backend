import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { parseDay, todayInAmsterdam } from '../../common/dates.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { costOf, priceOf, type PriceOverrides } from './ai.pricing.js';
import { AI_DEFINITIONS, AI_NAMESPACE, FEATURE_SETTING, REASONING_EFFORTS } from './ai.settings.js';
import {
  AI_FEATURES,
  AiError,
  type AiBudgetLevel,
  type AiBudgetStatus,
  type AiExtractRequest,
  type AiExtractResult,
  type AiFeature,
  type AiStatus,
  type AiTestResult,
  type AiTier,
} from './ai.types.js';

type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
type CreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type BudgetListener = (level: 'warning' | 'exceeded', status: AiBudgetStatus) => Promise<void> | void;

/** Reading a scanned contract can take a while; the provider's own retries (rate limits, short outages) happen inside this. */
const REQUEST_TIMEOUT_MS = 180_000;
const SDK_RETRIES = 3;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;

export interface AiUsageOverview {
  month: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  previousMonthCostUsd: number;
  byFeature: Array<{ feature: string; calls: number; errors: number; inputTokens: number; outputTokens: number; costUsd: number }>;
}

/**
 * The one door to the AI provider (OpenAI's Responses API). It answers in JSON that must fit a schema, sends only what the caller gives it, stores
 * nothing at the provider, keeps a usage line per call with an estimated cost, and stops calling once the month's budget is used. Everything it
 * returns still goes to a person for review — the AI never writes a record by itself.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: OpenAI | null = null;
  private readonly budgetListeners: BudgetListener[] = [];
  /** Models that refused the reasoning setting: it is left out of their calls from then on. */
  private readonly withoutReasoning = new Set<string>();

  constructor(
    private readonly config: AppConfigService,
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
  ) {
    settings.register(AI_NAMESPACE, AI_DEFINITIONS, { exposed: true });
  }

  /* ── What is possible right now ───────────────────────────────────────────────────────────────────────────────── */

  /** There is a key in the environment. */
  isConfigured(): boolean {
    return this.config.openai.apiKey !== null;
  }

  /** The key is set, the master switch is on and (for a feature) its own switch is on. */
  isEnabled(feature?: AiFeature): boolean {
    if (!this.isConfigured() || !this.read<boolean>('enabled')) return false;
    return feature ? this.featureOn(feature) : true;
  }

  private featureOn(feature: AiFeature): boolean {
    const key = FEATURE_SETTING[feature];
    return key ? this.read<boolean>(key) : true;
  }

  /** The biggest file that is sent to the AI, in bytes. */
  maxFileBytes(): number {
    return this.read<number>('maxFileMb') * 1024 * 1024;
  }

  /** The confidence below which a value is highlighted, as a fraction (0.85). */
  confidenceThreshold(): number {
    return this.read<number>('confidenceThreshold') / 100;
  }

  private read<T extends number | boolean | string>(name: keyof typeof AI_DEFINITIONS): T {
    return this.settings.get<T>(`${AI_NAMESPACE}.${name}`);
  }

  private modelFor(tier: AiTier): string {
    return tier === 'light' ? this.read<string>('classifyModel') : this.read<string>('model');
  }

  private priceOverrides(): PriceOverrides {
    return { inputCents: this.read<number>('priceInputCents'), outputCents: this.read<number>('priceOutputCents') };
  }

  /* ── Budget ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Called when a month's spend reaches the warning level and again when the budget is used up (once each, per month). */
  onBudgetLevel(listener: BudgetListener): void {
    this.budgetListeners.push(listener);
  }

  async budget(): Promise<AiBudgetStatus> {
    const month = todayInAmsterdam().slice(0, 7);
    const spent = await this.spentSince(parseDay(`${month}-01`));
    return this.budgetFor(month, spent);
  }

  private budgetFor(month: string, spentUsd: number): AiBudgetStatus {
    const limitUsd = this.read<number>('monthlyBudgetUsd');
    const warnAtPercent = this.read<number>('budgetWarnPercent');
    const percent = limitUsd > 0 ? Math.round((spentUsd / limitUsd) * 1000) / 10 : null;
    const level: AiBudgetLevel = limitUsd > 0 && spentUsd >= limitUsd ? 'exceeded' : percent !== null && percent >= warnAtPercent ? 'warning' : 'ok';
    return { limitUsd, spentUsd: Math.round(spentUsd * 10_000) / 10_000, percent, warnAtPercent, level, month };
  }

  private async spentSince(since: Date, until?: Date): Promise<number> {
    const total = await this.prisma.aiUsage.aggregate({ where: { createdAt: { gte: since, ...(until && { lt: until }) } }, _sum: { cost: true } });
    return total._sum.cost?.toNumber() ?? 0;
  }

  /** Tells the listeners when this call took the month's spend over the warning level or over the budget. */
  private async checkBudgetCrossing(month: string, before: number, cost: number): Promise<void> {
    const limit = this.read<number>('monthlyBudgetUsd');
    if (limit <= 0 || cost <= 0) return;
    const after = before + cost;
    const warnAt = (limit * this.read<number>('budgetWarnPercent')) / 100;
    const status = this.budgetFor(month, after);
    const level = before < limit && after >= limit ? 'exceeded' : before < warnAt && after >= warnAt ? 'warning' : null;
    if (!level) return;
    for (const listener of this.budgetListeners) {
      try {
        await listener(level, status);
      } catch (error) {
        this.logger.warn(`Budget notice failed: ${(error as Error).message}`);
      }
    }
  }

  /* ── Status and usage, for Settings → AI ──────────────────────────────────────────────────────────────────────── */

  async status(): Promise<AiStatus> {
    const configured = this.isConfigured();
    const enabled = this.read<boolean>('enabled');
    return {
      configured,
      enabled,
      available: configured && enabled,
      customEndpoint: this.config.openai.baseUrl !== undefined,
      model: this.read<string>('model'),
      classifyModel: this.read<string>('classifyModel'),
      budget: await this.budget(),
      features: Object.fromEntries(AI_FEATURES.filter(feature => feature !== 'test').map(feature => [feature, this.featureOn(feature)])),
      confidenceThreshold: this.read<number>('confidenceThreshold'),
      concurrency: this.read<number>('concurrency'),
      maxFileMb: this.read<number>('maxFileMb'),
    };
  }

  /** What the AI cost this month and last month, per feature. */
  async usage(): Promise<AiUsageOverview> {
    const month = todayInAmsterdam().slice(0, 7);
    const since = parseDay(`${month}-01`);
    const [year, number] = month.split('-').map(Number) as [number, number];
    const previous = parseDay(`${number === 1 ? year - 1 : year}-${String(number === 1 ? 12 : number - 1).padStart(2, '0')}-01`);
    const [rows, failed, previousMonthCostUsd] = await Promise.all([
      this.prisma.aiUsage.groupBy({ by: ['feature'], where: { createdAt: { gte: since } }, _sum: { inputTokens: true, outputTokens: true, cost: true }, _count: { _all: true } }),
      this.prisma.aiUsage.groupBy({ by: ['feature'], where: { createdAt: { gte: since }, status: { not: 'ok' } }, _count: { _all: true } }),
      this.spentSince(previous, since),
    ]);
    const failures = new Map(failed.map(row => [row.feature, row._count._all]));
    const byFeature = rows
      .map(row => ({
        feature: row.feature,
        calls: row._count._all,
        errors: failures.get(row.feature) ?? 0,
        inputTokens: row._sum.inputTokens ?? 0,
        outputTokens: row._sum.outputTokens ?? 0,
        costUsd: Math.round((row._sum.cost?.toNumber() ?? 0) * 10_000) / 10_000,
      }))
      .sort((a, b) => b.costUsd - a.costUsd);
    const sum = (pick: (row: (typeof byFeature)[number]) => number) => byFeature.reduce((total, row) => total + pick(row), 0);
    return {
      month,
      calls: sum(row => row.calls),
      errors: sum(row => row.errors),
      inputTokens: sum(row => row.inputTokens),
      outputTokens: sum(row => row.outputTokens),
      costUsd: Math.round(sum(row => row.costUsd) * 10_000) / 10_000,
      previousMonthCostUsd: Math.round(previousMonthCostUsd * 10_000) / 10_000,
      byFeature,
    };
  }

  /** Whether the price of a model is known (the screen warns when the cost is only a guess). */
  priceKnown(model: string): boolean {
    return priceOf(model, this.priceOverrides()).listed;
  }

  /* ── Asking ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /**
   * Sends one question (text and files) and returns the answer as an object that fits the schema. Throws an `AiError` — with `code` and whether a
   * new try makes sense — when the AI is off, over budget, unreachable or answers nonsense.
   */
  async extract<T>(request: AiExtractRequest): Promise<AiExtractResult<T>> {
    this.assertAvailable(request.feature);
    // One office, so many questions an hour (Settings → Security policy): a stuck loop or a huge import cannot run up the bill; the queue tries again later.
    if (request.feature !== 'test') {
      const perHour = this.settings.get<number>('security.aiRequestsPerHour');
      if ((await this.prisma.aiUsage.count({ where: { createdAt: { gte: new Date(Date.now() - 3_600_000) } } })) >= perHour) throw new AiError('ai_rate_limited', true, 'hour limit');
    }
    const month = todayInAmsterdam().slice(0, 7);
    const spentBefore = await this.spentSince(parseDay(`${month}-01`));
    if (request.feature !== 'test' && this.budgetFor(month, spentBefore).level === 'exceeded') throw new AiError('ai_budget_exceeded', false);

    const tier = request.tier ?? 'main';
    const model = this.modelFor(tier);
    const started = Date.now();
    try {
      const response = await this.call(model, request);
      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const costUsd = costOf(model, inputTokens, outputTokens, this.priceOverrides());
      const refusal = response.output.flatMap(item => (item.type === 'message' ? item.content : [])).find(part => part.type === 'refusal');
      if (refusal) {
        await this.record(request, model, response, costUsd, 'refused', 'ai_refused', Date.now() - started);
        await this.checkBudgetCrossing(month, spentBefore, costUsd);
        throw new AiError('ai_refused', false);
      }
      if (response.status === 'incomplete') {
        await this.record(request, model, response, costUsd, 'error', 'ai_incomplete', Date.now() - started);
        await this.checkBudgetCrossing(month, spentBefore, costUsd);
        throw new AiError('ai_incomplete', false, response.incomplete_details?.reason ?? undefined);
      }
      let data: T;
      try {
        data = JSON.parse(response.output_text) as T;
      } catch {
        await this.record(request, model, response, costUsd, 'error', 'ai_invalid_output', Date.now() - started);
        await this.checkBudgetCrossing(month, spentBefore, costUsd);
        throw new AiError('ai_invalid_output', false);
      }
      await this.record(request, model, response, costUsd, 'ok', '', Date.now() - started);
      await this.checkBudgetCrossing(month, spentBefore, costUsd);
      return { data, model, inputTokens, outputTokens, costUsd };
    } catch (error) {
      if (error instanceof AiError) throw error;
      const mapped = this.mapError(error);
      await this.recordFailure(request, model, mapped.code, Date.now() - started);
      throw mapped;
    }
  }

  private assertAvailable(feature: AiFeature): void {
    if (!this.isConfigured()) throw new AiError('ai_not_configured', false);
    if (feature === 'test') return;
    if (!this.read<boolean>('enabled')) throw new AiError('ai_disabled', false);
    if (!this.featureOn(feature)) throw new AiError('ai_feature_off', false);
  }

  private openai(): OpenAI {
    if (!this.client) {
      const { apiKey, baseUrl } = this.config.openai;
      this.client = new OpenAI({ apiKey: apiKey ?? undefined, baseURL: baseUrl, maxRetries: SDK_RETRIES, timeout: REQUEST_TIMEOUT_MS });
    }
    return this.client;
  }

  private buildParams(model: string, request: AiExtractRequest, withReasoning: boolean): CreateParams {
    const content: OpenAI.Responses.ResponseInputContent[] = [];
    if (request.text) content.push({ type: 'input_text', text: request.text });
    for (const file of request.files ?? []) {
      const dataUrl = `data:${file.mime};base64,${file.data.toString('base64')}`;
      if (file.kind === 'image') content.push({ type: 'input_image', image_url: dataUrl, detail: file.detail ?? 'high' });
      else content.push({ type: 'input_file', filename: file.name, file_data: dataUrl, ...(file.detail && { detail: file.detail }) });
    }
    return {
      model,
      instructions: request.instructions,
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: request.schemaName, schema: request.schema, strict: true } },
      max_output_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      // Nothing is stored at the provider: the files are read and forgotten.
      store: false,
      ...(withReasoning && { reasoning: { effort: this.read<ReasoningEffort>('reasoningEffort') } }),
    };
  }

  /** One request; a model that does not know the reasoning setting is asked again without it (and remembered). */
  private async call(model: string, request: AiExtractRequest): Promise<OpenAI.Responses.Response> {
    const options = { signal: request.signal, timeout: REQUEST_TIMEOUT_MS };
    const withReasoning = !this.withoutReasoning.has(model);
    try {
      return await this.openai().responses.create(this.buildParams(model, request, withReasoning), options);
    } catch (error) {
      const refusesReasoning = withReasoning && error instanceof OpenAI.BadRequestError && /reasoning/i.test(`${error.param ?? ''} ${error.message}`);
      if (!refusesReasoning) throw error;
      this.logger.warn(`Model ${model} does not take the reasoning setting; asking without it from now on`);
      this.withoutReasoning.add(model);
      return await this.openai().responses.create(this.buildParams(model, request, false), options);
    }
  }

  private mapError(error: unknown): AiError {
    if (error instanceof OpenAI.APIUserAbortError) return new AiError('ai_failed', true, 'aborted');
    if (error instanceof OpenAI.APIConnectionTimeoutError) return new AiError('ai_unreachable', true, 'timeout');
    if (error instanceof OpenAI.APIConnectionError) return new AiError('ai_unreachable', true, error.message);
    if (error instanceof OpenAI.APIError) {
      const status = error.status;
      const detail = `${status ?? ''} ${error.code ?? ''} ${error.message}`.trim();
      if (status === 401 || status === 403) return new AiError('ai_key_invalid', false, detail);
      if (status === 404 || error.code === 'model_not_found') return new AiError('ai_model_unknown', false, detail);
      if (status === 429) return error.code === 'insufficient_quota' ? new AiError('ai_quota', false, detail) : new AiError('ai_rate_limited', true, detail);
      if (status !== undefined && status >= 400 && status < 500) return new AiError('ai_request_rejected', false, detail);
      return new AiError('ai_unreachable', true, detail);
    }
    return new AiError('ai_failed', true, (error as Error)?.message);
  }

  /* ── Usage lines ──────────────────────────────────────────────────────────────────────────────────────────────── */

  private async record(request: AiExtractRequest, model: string, response: OpenAI.Responses.Response, costUsd: number, status: 'ok' | 'error' | 'refused', error: string, durationMs: number): Promise<void> {
    await this.write({
      feature: request.feature,
      model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cachedTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      cost: costUsd,
      status,
      error,
      itemId: request.itemId ?? null,
      userId: request.userId ?? null,
      durationMs,
    });
  }

  private async recordFailure(request: AiExtractRequest, model: string, code: string, durationMs: number): Promise<void> {
    await this.write({ feature: request.feature, model, cost: 0, status: 'error', error: code, itemId: request.itemId ?? null, userId: request.userId ?? null, durationMs });
  }

  private async write(data: Parameters<PrismaService['aiUsage']['create']>[0]['data']): Promise<void> {
    try {
      await this.prisma.aiUsage.create({ data });
    } catch (error) {
      // The answer is worth more than its bookkeeping.
      this.logger.warn(`Could not write the AI usage line: ${(error as Error).message.split('\n')[0]}`);
    }
  }

  /* ── Connection test ──────────────────────────────────────────────────────────────────────────────────────────── */

  /** Asks each model (the sorting one and the reading one) for a trivial answer, so Settings → AI can say whether the key and the names work. */
  async test(userId?: string | null): Promise<AiTestResult[]> {
    const tiers: AiTier[] = this.modelFor('light') === this.modelFor('main') ? ['main'] : ['light', 'main'];
    const results: AiTestResult[] = [];
    for (const tier of tiers) {
      const model = this.modelFor(tier);
      const started = Date.now();
      try {
        await this.extract<{ ok: boolean }>({
          feature: 'test',
          tier,
          instructions: 'Answer with {"ok": true}.',
          schemaName: 'connection_test',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          maxOutputTokens: 300,
          userId,
        });
        results.push({ model, tier, ok: true, durationMs: Date.now() - started });
      } catch (error) {
        const failure = error instanceof AiError ? error : new AiError('ai_failed', true, (error as Error).message);
        results.push({ model, tier, ok: false, code: failure.code, detail: failure.message, durationMs: Date.now() - started });
      }
    }
    return results;
  }
}
