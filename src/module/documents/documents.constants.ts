/** The permission area of the Documents page: who may open it and work with documents (what a person sees of each document is decided by the area of the file). */
export const DOCUMENTS_AREA = 'documents';

/** Records a document can also belong to besides the place it is filed, with the area that guards each. */
export const LINK_TYPES = {
  client: { area: 'clients' },
  employee: { area: 'employees' },
  contract: { area: 'contracts' },
  invoice: { area: 'invoices' },
  salary_statement: { area: 'salary_statements' },
} as const;
export type LinkType = keyof typeof LINK_TYPES;
export const LINK_TYPE_KEYS = Object.keys(LINK_TYPES) as LinkType[];

/** Documents are looked at in pages; a list that has to be computed in memory (status filters, exports) stops here. */
export const COMPUTED_LIMIT = 20_000;

/** The longest snippet shown under a document that was found by what it says. */
export const SNIPPET_LENGTH = 160;

/** The text of a document is cut off here (a long contract is still far below). */
export const MAX_TEXT_CHARACTERS = 200_000;

/** How many documents without a read text are picked up each time the queue starts. */
export const INDEX_BACKFILL_BATCH = 500;
