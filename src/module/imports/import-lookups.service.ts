import { Injectable } from '@nestjs/common';
import { fold } from '../../common/text.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { Choice, CoerceContext } from './value-coercion.js';

/**
 * What the reading of values looks things up in — pick-lists, staff, clients — loaded once per import (a spreadsheet of 300 rows must not ask the
 * database 300 times which legal forms exist).
 */
@Injectable()
export class ImportLookupsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The role a person gets at a company of this legal form (owner of a sole proprietorship, director of a B.V. …): the `person_role` item that names the form; `contact` otherwise. */
  async roleFor(legalForm: string | null | undefined): Promise<string> {
    const roles = await this.prisma.listItem.findMany({ where: { isActive: true, list: { key: 'person_role' } }, select: { code: true, meta: true } });
    const match = roles.find(role => {
      const forms = (role.meta as Record<string, unknown> | null)?.legalForms;
      return typeof forms === 'string' && forms.split(',').map(code => code.trim()).includes(legalForm ?? '');
    });
    return match?.code ?? 'contact';
  }

  async context(): Promise<CoerceContext> {
    const [items, users, clients] = await Promise.all([
      this.prisma.listItem.findMany({ where: { isActive: true }, select: { code: true, nameNl: true, nameEn: true, list: { select: { key: true } } } }),
      this.prisma.user.findMany({ where: { status: 'active' }, select: { id: true, name: true, email: true } }),
      this.prisma.client.findMany({ select: { id: true, number: true, name: true } }),
    ]);
    const lists = new Map<string, Choice[]>();
    for (const item of items) lists.set(item.list.key, [...(lists.get(item.list.key) ?? []), { code: item.code, names: [item.nameNl, item.nameEn] }]);

    const clientsByNumber = new Map<string, string>();
    const clientsByName = new Map<string, string[]>();
    for (const client of clients) {
      clientsByNumber.set(fold(client.number), client.id);
      // "042" and "42" are the same number when both are only digits.
      if (/^\d+$/.test(client.number)) clientsByNumber.set(String(Number(client.number)), client.id);
      const name = fold(client.name);
      clientsByName.set(name, [...(clientsByName.get(name) ?? []), client.id]);
    }
    return { lists, users: users.map(user => ({ id: user.id, names: [user.name, user.email] })), clientsByNumber, clientsByName };
  }
}
