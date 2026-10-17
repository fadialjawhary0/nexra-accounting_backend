import type { Prisma } from '../../generated/prisma/client.js';

/** The permission area that guards invoices, companies and the reports built on them. */
export const INVOICES_AREA = 'invoices';

/** The statuses of an invoice that make its hours "invoiced": a draft is not an invoice yet, a cancelled one never was. */
export const COUNTED_STATUSES = ['sent', 'paid', 'received', 'checked'] as const;

/** An invoice with a credit note that was not cancelled is taken back as a whole: neither of the two counts. */
export const COUNTED_INVOICE: Prisma.InvoiceWhereInput = {
  status: { in: [...COUNTED_STATUSES] },
  kind: 'invoice',
  credits: { none: { status: { not: 'cancelled' } } },
};
