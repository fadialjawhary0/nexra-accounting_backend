import { Injectable } from '@nestjs/common';
import { fold } from '../../common/text.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormsService } from '../forms/forms.service.js';

export interface ClientRef {
  id: string;
  number: string;
  name: string;
}

export interface WorkerRef {
  employeeId: string;
  personId: string;
  name: string;
  isActive: boolean;
  tokens: string[];
}

/** Words in a name that are not part of who somebody is when comparing names ("Jan van der Berg" and "Berg, Jan"). */
const PARTICLES = new Set(['van', 'de', 'der', 'den', 'ter', 'ten', 'het', 'te', 'la', 'le', 'el', 'al', 'bin', 'ben', 'ibn', 'von', 'du', 'da', 'di', 'dos']);
const CACHE_MS = 30_000;

/** The words that identify a person in a text: lower case, no accents, no particles, no single letters. */
export function nameTokens(text: string): string[] {
  return fold(text)
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1 && !PARTICLES.has(token));
}

const containsAll = (haystack: readonly string[], needles: readonly string[]): boolean => needles.length > 0 && needles.every(token => haystack.includes(token));

/**
 * Finds the records a document belongs to: the client (by the folder number, the KvK number or the company name), the worker (by name, among the
 * workers of that client) and the person (by BSN, or by name and date of birth). It never creates anything and never guesses between two equally
 * good candidates — an ambiguous match is reported as none, and the review list asks the person.
 */
@Injectable()
export class DocumentMatcherService {
  private index: { at: number; byNumber: Map<string, ClientRef>; all: ClientRef[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly records: FormRecordsService,
    private readonly forms: FormsService,
  ) {}

  /** Every client by number (cached for a short while: an import of 2000 files asks 2000 times). */
  private async clients() {
    if (this.index && Date.now() - this.index.at < CACHE_MS) return this.index;
    const all = await this.prisma.client.findMany({ select: { id: true, number: true, name: true } });
    const byNumber = new Map<string, ClientRef>();
    for (const client of all) {
      byNumber.set(fold(client.number), client);
      if (/^\d+$/.test(client.number)) byNumber.set(String(Number(client.number)), client);
    }
    this.index = { at: Date.now(), byNumber, all };
    return this.index;
  }

  /** The client of the first folder number that is one (`042` finds client `42`). */
  async clientByNumbers(numbers: readonly string[]): Promise<ClientRef | null> {
    const { byNumber } = await this.clients();
    for (const number of numbers) {
      const found = byNumber.get(fold(number)) ?? (/^\d+$/.test(number) ? byNumber.get(String(Number(number))) : undefined);
      if (found) return found;
    }
    return null;
  }

  async clientById(id: string): Promise<ClientRef | null> {
    const { all } = await this.clients();
    return all.find(client => client.id === id) ?? (await this.prisma.client.findUnique({ where: { id }, select: { id: true, number: true, name: true } }));
  }

  async clientByKvk(kvk: string | null | undefined): Promise<ClientRef | null> {
    const digits = (kvk ?? '').replace(/\D/g, '');
    if (digits.length !== 8) return null;
    return this.prisma.client.findFirst({ where: { kvk: digits }, select: { id: true, number: true, name: true } });
  }

  /** A client whose name is exactly this (ignoring capitals and punctuation), or the only client whose name contains it. */
  async clientByName(name: string | null | undefined): Promise<ClientRef | null> {
    const wanted = fold(name ?? '').replace(/[^a-z0-9 ]/g, '').trim();
    if (wanted.length < 3) return null;
    const { all } = await this.clients();
    const clean = (text: string) => fold(text).replace(/[^a-z0-9 ]/g, '').trim();
    const exact = all.filter(client => clean(client.name) === wanted);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1 || wanted.length < 5) return null;
    const near = all.filter(client => clean(client.name).includes(wanted) || wanted.includes(clean(client.name)));
    return near.length === 1 && clean(near[0]!.name).length >= 5 ? near[0]! : null;
  }

  /** The workers of a client (those who left too, they have documents as well). */
  async workersOf(clientId: string): Promise<WorkerRef[]> {
    const rows = await this.prisma.employee.findMany({ where: { clientId }, select: { id: true, personId: true, isActive: true, person: { select: { firstName: true, lastName: true } } } });
    return rows.map(row => ({
      employeeId: row.id,
      personId: row.personId,
      isActive: row.isActive,
      name: `${row.person.firstName} ${row.person.lastName}`.trim(),
      tokens: nameTokens(`${row.person.firstName} ${row.person.lastName}`),
    }));
  }

  /** The client with exactly this name (ignoring capitals and punctuation), when there is just one. */
  async clientByExactName(name: string | null | undefined): Promise<ClientRef | null> {
    const clean = (text: string) => fold(text).replace(/[^a-z0-9 ]/g, '').trim();
    const wanted = clean(name ?? '');
    if (!wanted) return null;
    const { all } = await this.clients();
    const found = all.filter(client => clean(client.name) === wanted);
    return found.length === 1 ? found[0]! : null;
  }

  /** A worker (of any client) whose name fits: one candidate, `'ambiguous'` for several, `null` for none. Only people who work now are looked at. */
  async workerAnywhere(name: string | null | undefined): Promise<WorkerRef | 'ambiguous' | null> {
    const tokens = nameTokens(name ?? '');
    if (!tokens.length) return null;
    const rows = await this.prisma.employee.findMany({
      where: { isActive: true, AND: tokens.map(token => ({ person: { searchText: { contains: token } } })) },
      select: { id: true, personId: true, isActive: true, person: { select: { firstName: true, lastName: true } } },
      take: 4,
    });
    if (rows.length === 1) {
      const row = rows[0]!;
      return { employeeId: row.id, personId: row.personId, isActive: row.isActive, name: `${row.person.firstName} ${row.person.lastName}`.trim(), tokens: nameTokens(`${row.person.firstName} ${row.person.lastName}`) };
    }
    return rows.length ? 'ambiguous' : null;
  }

  /** The worker of a client a name stands for: one candidate, `'ambiguous'` for several, `null` for none. */
  async workerByName(clientId: string, name: string | null | undefined, workers?: WorkerRef[]): Promise<WorkerRef | 'ambiguous' | null> {
    const tokens = nameTokens(name ?? '');
    if (!tokens.length) return null;
    const candidates = (workers ?? (await this.workersOf(clientId))).filter(worker => containsAll(tokens, worker.tokens) || (tokens.length >= 2 && containsAll(worker.tokens, tokens)));
    if (candidates.length === 1) return candidates[0]!;
    // Several people match a short name: prefer the one whose whole name is there, and one who still works for the client.
    const exact = candidates.filter(worker => worker.tokens.length === tokens.length);
    if (exact.length === 1) return exact[0]!;
    const active = candidates.filter(worker => worker.isActive);
    return active.length === 1 ? active[0]! : candidates.length ? 'ambiguous' : null;
  }

  /** The person who holds this BSN (the BSN is unique: the lookup goes through the same index the form uses). */
  async personByBsn(bsn: string | null | undefined): Promise<string | null> {
    if (!bsn) return null;
    const { doc } = await this.forms.live('person');
    const { conflicts } = await this.records.checkUnique('person', null, doc, { bsn }, {});
    return conflicts.bsn ?? null;
  }

  /** The person with this name and date of birth — only when both are known, so two different people with the same name are never merged. */
  async personByNameAndBirth(first: string | null | undefined, last: string | null | undefined, dateOfBirth: string | null | undefined): Promise<string | null> {
    if (!first || !last || !dateOfBirth) return null;
    const candidates = await this.prisma.person.findMany({ where: { lastName: { equals: last.trim(), mode: 'insensitive' }, firstName: { equals: first.trim(), mode: 'insensitive' } }, select: { id: true, data: true }, take: 10 });
    const same = candidates.filter(candidate => (candidate.data as Record<string, unknown> | null)?.date_of_birth === dateOfBirth);
    return same.length === 1 ? same[0]!.id : null;
  }

  /** Is there somebody with a similar name already? (To warn before a possible duplicate is made.) */
  async similarPeople(first: string | null | undefined, last: string | null | undefined): Promise<Array<{ id: string; name: string }>> {
    if (!last) return [];
    const rows = await this.prisma.person.findMany({ where: { lastName: { equals: last.trim(), mode: 'insensitive' } }, select: { id: true, firstName: true, lastName: true }, take: 5 });
    const firstToken = nameTokens(first ?? '')[0];
    return rows.filter(row => !firstToken || nameTokens(row.firstName)[0] === firstToken).map(row => ({ id: row.id, name: `${row.firstName} ${row.lastName}`.trim() }));
  }
}
