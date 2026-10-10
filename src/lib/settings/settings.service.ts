import { Injectable, Logger, UnprocessableEntityException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { FORMATS, type FormatName } from '../../common/validation/formats.js';
import { PrismaService } from '../database/prisma.service.js';

export type SettingValue = number | boolean | string | string[];

export interface SettingDefinition {
  type: 'int' | 'bool' | 'string' | 'enum' | 'multi';
  default: SettingValue;
  /** int — enforced when saving and again when reading; multi — how many members may be chosen (enforced when saving). */
  min?: number;
  max?: number;
  /** string — longest text (default 200). */
  maxLength?: number;
  /** string — may not be empty. */
  required?: boolean;
  /** string — must fit this Dutch format; the stored value is the normalised one (`1234ab` → `1234 AB`). */
  format?: FormatName;
  /** enum — the allowed value; multi — the allowed members. */
  options?: readonly string[];
  /** For screens: which card the setting belongs to. */
  group?: string;
}

/** A group of settings: `{ loginMaxFailures: { type: 'int', default: 5, min: 3, max: 20 } }`. */
export type SettingDefinitions = Record<string, SettingDefinition>;

interface RegisterOptions {
  /** Editable through the generic `GET|PUT /settings/:namespace` screens (security has its own endpoint and extra rules). */
  exposed?: boolean;
}

const REFRESH_MS = 30_000;
const DEFAULT_MAX_LENGTH = 200;

/**
 * Typed settings: the definitions (type, default, bounds) live in code, only values that differ from the default are stored.
 * Reads come from an in-memory cache (refreshed on every change and every 30 s), so guards and services can read a limit without
 * touching the database — and a change takes effect without a restart.
 */
@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettingsService.name);
  private readonly definitions = new Map<string, SettingDefinition>();
  private readonly exposed = new Set<string>();
  private stored = new Map<string, unknown>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  /** Registers a group; call it once from the module that owns the settings. */
  register(namespace: string, definitions: SettingDefinitions, options: RegisterOptions = {}): void {
    for (const [name, definition] of Object.entries(definitions)) this.definitions.set(`${namespace}.${name}`, definition);
    if (options.exposed) this.exposed.add(namespace);
  }

  /** Namespaces the generic settings screens may read and write. */
  isExposed(namespace: string): boolean {
    return this.exposed.has(namespace);
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.reload(), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async reload(): Promise<void> {
    try {
      const rows = await this.prisma.setting.findMany();
      this.stored = new Map(rows.map(row => [row.key, row.value]));
    } catch (error) {
      this.logger.warn(`Could not load settings, using the cached values (${(error as Error).message.split('\n')[0]})`);
    }
  }

  /** The current value, clamped to its limits. */
  get<T extends SettingValue>(key: string): T {
    const definition = this.definitionOf(key);
    return this.normalize(definition, this.stored.get(key)) as T;
  }

  /** `{ name: value }` for every setting of a namespace. */
  group(namespace: string): Record<string, SettingValue> {
    const prefix = `${namespace}.`;
    return Object.fromEntries([...this.definitions.keys()].filter(key => key.startsWith(prefix)).map(key => [key.slice(prefix.length), this.get(key)]));
  }

  /** The definitions of a namespace, for screens that show limits next to the inputs. */
  definitionsOf(namespace: string): Record<string, SettingDefinition> {
    const prefix = `${namespace}.`;
    return Object.fromEntries([...this.definitions].filter(([key]) => key.startsWith(prefix)).map(([key, definition]) => [key.slice(prefix.length), definition]));
  }

  /**
   * Validates and stores some values of a namespace; throws 422 with a field message per bad value. A value equal to the
   * default is removed again, so the table only holds real choices. Returns the new values of the namespace.
   */
  async setGroup(namespace: string, values: Record<string, unknown>, actorId?: string | null): Promise<Record<string, SettingValue>> {
    const fields: Record<string, string> = {};
    const accepted: Array<[string, SettingValue]> = [];
    for (const [name, raw] of Object.entries(values)) {
      const definition = this.definitions.get(`${namespace}.${name}`);
      if (!definition) continue;
      const result = this.validate(definition, raw);
      if (result.error) fields[name] = result.error;
      else accepted.push([`${namespace}.${name}`, result.value as SettingValue]);
    }
    if (Object.keys(fields).length) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields });

    for (const [key, value] of accepted) {
      const definition = this.definitionOf(key);
      if (JSON.stringify(value) === JSON.stringify(definition.default)) {
        await this.prisma.setting.deleteMany({ where: { key } });
        this.stored.delete(key);
      } else {
        await this.prisma.setting.upsert({ where: { key }, create: { key, value, updatedById: actorId ?? null }, update: { value, updatedById: actorId ?? null } });
        this.stored.set(key, value);
      }
    }
    return this.group(namespace);
  }

  private definitionOf(key: string): SettingDefinition {
    const definition = this.definitions.get(key);
    if (!definition) throw new Error(`Unknown setting: ${key}`);
    return definition;
  }

  /** `error` is a translation key (`validation.min|{"min":3}`); `value` is what gets stored (normalised). */
  private validate(definition: SettingDefinition, raw: unknown): { error?: string; value?: SettingValue } {
    switch (definition.type) {
      case 'bool':
        return typeof raw === 'boolean' ? { value: raw } : { error: 'validation.selectOption' };
      case 'int': {
        if (typeof raw !== 'number' || !Number.isInteger(raw)) return { error: 'validation.wholeNumber' };
        if (definition.min !== undefined && raw < definition.min) return { error: `validation.min|${JSON.stringify({ min: definition.min })}` };
        if (definition.max !== undefined && raw > definition.max) return { error: `validation.max|${JSON.stringify({ max: definition.max })}` };
        return { value: raw };
      }
      case 'string': {
        if (typeof raw !== 'string') return { error: 'validation.required' };
        const text = raw.trim();
        if (!text) return definition.required ? { error: 'validation.required' } : { value: '' };
        const max = definition.maxLength ?? DEFAULT_MAX_LENGTH;
        if (text.length > max) return { error: `validation.maxLength|${JSON.stringify({ max })}` };
        if (!definition.format) return { value: text };
        const normalized = FORMATS[definition.format].normalize(text);
        return normalized === null ? { error: `validation.${FORMATS[definition.format].messageKey}` } : { value: normalized };
      }
      case 'enum':
        return typeof raw === 'string' && definition.options?.includes(raw) ? { value: raw } : { error: 'validation.selectOption' };
      case 'multi': {
        if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string' || !definition.options?.includes(item))) return { error: 'validation.selectOption' };
        const value = (definition.options ?? []).filter(option => raw.includes(option));
        if (definition.min !== undefined && value.length < definition.min) return { error: `validation.minItems|${JSON.stringify({ min: definition.min })}` };
        if (definition.max !== undefined && value.length > definition.max) return { error: `validation.maxItems|${JSON.stringify({ max: definition.max })}` };
        return { value };
      }
    }
  }

  private normalize(definition: SettingDefinition, raw: unknown): SettingValue {
    switch (definition.type) {
      case 'bool':
        return typeof raw === 'boolean' ? raw : (definition.default as boolean);
      case 'int': {
        const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : (definition.default as number);
        return Math.min(Math.max(value, definition.min ?? Number.NEGATIVE_INFINITY), definition.max ?? Number.POSITIVE_INFINITY);
      }
      case 'string':
        return typeof raw === 'string' ? raw : (definition.default as string);
      case 'enum':
        return typeof raw === 'string' && definition.options?.includes(raw) ? raw : (definition.default as string);
      case 'multi':
        return Array.isArray(raw) ? (definition.options ?? []).filter(option => raw.includes(option)) : (definition.default as string[]);
    }
  }
}
