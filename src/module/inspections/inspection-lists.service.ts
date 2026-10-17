import { Injectable } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { asRecord } from '../../common/record-values.js';
import { PrismaService } from '../../lib/database/prisma.service.js';

export interface ListEntry {
  code: string;
  nameNl: string;
  nameEn: string;
  isActive: boolean;
  meta: Record<string, unknown>;
}

/** The pick-lists and status lookups inspections use (types, bodies, statuses, outcomes …), read as codes, names and flags. */
@Injectable()
export class InspectionListsService {
  constructor(private readonly prisma: PrismaService) {}

  async entries(key: string): Promise<ListEntry[]> {
    const items = await this.prisma.listItem.findMany({ where: { list: { key } }, orderBy: [{ sortOrder: 'asc' }, { nameNl: 'asc' }], select: { code: true, nameNl: true, nameEn: true, isActive: true, meta: true } });
    return items.map(item => ({ code: item.code, nameNl: item.nameNl, nameEn: item.nameEn, isActive: item.isActive, meta: asRecord(item.meta) }));
  }

  /** `code → name` in the language asked for. */
  async names(key: string, locale: AppLocale): Promise<Map<string, string>> {
    return new Map((await this.entries(key)).map(item => [item.code, locale === 'nl' ? item.nameNl : item.nameEn]));
  }

  /** The codes a record may be given today. */
  async activeCodes(key: string): Promise<Set<string>> {
    return new Set((await this.entries(key)).filter(item => item.isActive).map(item => item.code));
  }

  /** The flags of one item (`{ recurring: true }`). */
  async metaOf(key: string, code: string): Promise<Record<string, unknown>> {
    return (await this.entries(key)).find(item => item.code === code)?.meta ?? {};
  }
}
