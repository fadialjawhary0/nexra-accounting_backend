import { formatDay } from '../../common/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { fromCents, toCents } from '../hours/hours-time.js';
import { personName } from '../people/person-record.js';
import type { InvoiceDirection, InvoiceStatus } from './invoices.constants.js';

/** What a list needs of an invoice. */
export const LIST_INCLUDE = {
  client: { select: { id: true, number: true, name: true } },
  counterparty: { select: { id: true, name: true } },
  otherClient: { select: { id: true, number: true, name: true } },
  lines: { select: { kind: true, minutes: true, employeeId: true } },
} satisfies Prisma.InvoiceInclude;
export type ListRow = Prisma.InvoiceGetPayload<{ include: typeof LIST_INCLUDE }>;

/** What one invoice needs: its lines with their workers, the credit notes around it. */
export const DETAIL_INCLUDE = {
  client: { select: { id: true, number: true, name: true, isActive: true } },
  counterparty: { select: { id: true, name: true } },
  otherClient: { select: { id: true, number: true, name: true } },
  lines: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], include: { employee: { include: { person: true, client: { select: { number: true } } } } } },
  creditOf: { select: { id: true, number: true, status: true } },
  credits: { select: { id: true, number: true, status: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.InvoiceInclude;
export type DetailRow = Prisma.InvoiceGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/** The statuses in which an invoice still has to be paid. */
export const OPEN_STATUSES: readonly InvoiceStatus[] = ['sent', 'received', 'checked'];

/** The other party of an invoice: a company that is not a client, or another client. */
export function partyOf(row: Pick<ListRow, 'counterparty' | 'otherClient'>): { type: 'counterparty' | 'client'; id: string; name: string; number: string | null } {
  if (row.counterparty) return { type: 'counterparty', id: row.counterparty.id, name: row.counterparty.name, number: null };
  const client = row.otherClient as NonNullable<ListRow['otherClient']>;
  return { type: 'client', id: client.id, name: client.name, number: client.number };
}

export const partyLabel = (party: ReturnType<typeof partyOf>): string => (party.number ? `${party.number} – ${party.name}` : party.name);

export const euros = (value: { toNumber(): number }): number => value.toNumber();
export const centsOf = (value: { toNumber(): number }): number => toCents(value.toNumber());
export { fromCents };

/** What the screens show of a list row. */
export function listView(row: ListRow, today: string) {
  const hours = row.lines.filter(line => line.kind === 'hours');
  const open = (OPEN_STATUSES as readonly string[]).includes(row.status);
  return {
    id: row.id,
    direction: row.direction as InvoiceDirection,
    kind: row.kind,
    number: row.number,
    status: row.status as InvoiceStatus,
    client: row.client,
    party: partyOf(row),
    invoiceDate: row.invoiceDate ? formatDay(row.invoiceDate) : null,
    dueDate: row.dueDate ? formatDay(row.dueDate) : null,
    periodFrom: formatDay(row.periodFrom),
    periodTo: formatDay(row.periodTo),
    minutes: hours.reduce((sum, line) => sum + line.minutes, 0),
    subtotal: euros(row.subtotal),
    vatAmount: euros(row.vatAmount),
    total: euros(row.total),
    gAccountAmount: euros(row.gAccountAmount),
    paidOn: row.paidOn ? formatDay(row.paidOn) : null,
    hasDocument: Boolean(row.fileId || row.pdfFileId),
    creditOfId: row.creditOfId,
    unmatchedLines: hours.filter(line => !line.employeeId).length,
    overdue: row.kind === 'invoice' && open && Boolean(row.dueDate) && formatDay(row.dueDate as Date) < today,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A worker as an invoice line shows them. */
export const workerBrief = (employee: NonNullable<DetailRow['lines'][number]['employee']>) => ({ id: employee.id, name: personName(employee.person), clientNumber: employee.client.number });
