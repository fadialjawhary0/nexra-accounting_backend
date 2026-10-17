import { Injectable, type OnModuleInit } from '@nestjs/common';
import { formatDay } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SearchService } from '../search/search.service.js';
import type { SearchHit } from '../search/search.types.js';

const dutch = (day: string): string => day.split('-').reverse().join('-');

/** The official forms of the library (by name and the code printed on them) and the forms that were filled in for clients (by form, client number and name). */
@Injectable()
export class OfficialFormSearchProvider implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    this.search.register({ key: 'officialForms', area: 'official_forms', order: 60, find: (query, limit, context) => this.find(query.terms, limit, context.locale) });
  }

  private async find(terms: string[], limit: number, locale: AppLocale): Promise<SearchHit[]> {
    const insensitive = 'insensitive' as const;
    const [forms, submissions] = await Promise.all([
      this.prisma.officialForm.findMany({
        where: { isActive: true, AND: terms.map(term => ({ OR: [{ nameNl: { contains: term, mode: insensitive } }, { nameEn: { contains: term, mode: insensitive } }, { code: { contains: term, mode: insensitive } }, { authorityCode: { contains: term, mode: insensitive } }] })) },
        orderBy: { sortOrder: 'asc' },
        take: limit,
        select: { id: true, nameNl: true, nameEn: true, authorityCode: true },
      }),
      this.prisma.formSubmission.findMany({
        where: {
          isActive: true,
          AND: terms.map(term => ({
            OR: [
              { searchText: { contains: term } },
              { client: { number: { contains: term, mode: insensitive } } },
              { client: { name: { contains: term, mode: insensitive } } },
              { form: { nameNl: { contains: term, mode: insensitive } } },
              { form: { nameEn: { contains: term, mode: insensitive } } },
            ],
          })),
        },
        orderBy: { preparedOn: 'desc' },
        take: limit,
        select: { id: true, preparedOn: true, form: { select: { nameNl: true, nameEn: true } }, client: { select: { number: true, name: true } } },
      }),
    ]);
    const hits: SearchHit[] = [
      ...forms.map(form => ({ id: form.id, title: locale === 'nl' ? form.nameNl : form.nameEn, subtitle: form.authorityCode, href: `/official-forms/${form.id}` })),
      ...submissions.map(row => ({ id: row.id, title: `${locale === 'nl' ? row.form.nameNl : row.form.nameEn} · ${row.client.number} ${row.client.name}`, subtitle: dutch(formatDay(row.preparedOn)), href: `/official-forms/sent?open=${row.id}` })),
    ];
    return hits.slice(0, limit);
  }
}
