/*
 * What the program knows about documents: who a type is for, how its validity is known, and the pieces a file name can be made of. The names, the
 * rules and the order of the types themselves belong to the office (Settings → Documents); only the *kinds* of rule live here.
 */

/** Who a type of document is for: the company (`client`), one of its workers (`worker`) or either (`any`). */
export const DOCUMENT_SCOPES = ['client', 'worker', 'any'] as const;
export type DocumentScope = (typeof DOCUMENT_SCOPES)[number];

/**
 * How the end of a document's validity is known:
 *   none  — it never expires (a letter);
 *   age   — it is good for a number of months from the date on it (a KvK extract: 3 months);
 *   date  — a "valid until" typed on the file (an agreement with an end date);
 *   field — the end date lives in the worker's record (`id_expiry`) and the document follows it.
 */
export const VALIDITY_KINDS = ['none', 'age', 'date', 'field'] as const;
export type ValidityKind = (typeof VALIDITY_KINDS)[number];

/** The pieces a naming pattern may use: `{number} - {type} {date}`. */
export const NAME_TOKENS = ['number', 'client', 'worker', 'type', 'date', 'year', 'month', 'original'] as const;
export type NameToken = (typeof NAME_TOKENS)[number];

/** The file fields of the person form that hold a copy of a document, and the type of document the copy is (`id_file` → an ID document). */
export const PERSON_FILE_TYPES: Readonly<Record<string, string>> = { id_file: 'id_document', permit_file: 'residence_permit' };

/** The folders a standard folder can sit in at the most (the client's folder is level 0). */
export const MAX_TEMPLATE_DEPTH = 3;

/** Who a requirement is about. */
export const REQUIREMENT_SCOPES = ['client', 'worker'] as const;
export type RequirementScope = (typeof REQUIREMENT_SCOPES)[number];

/** The forms whose fields a requirement's rule may look at, with the prefix its keys carry (`person.permit_type`). */
export const REQUIREMENT_FORMS = [
  { entity: 'client', prefix: 'client.', scopes: ['client', 'worker'] },
  { entity: 'employee', prefix: 'employee.', scopes: ['worker'] },
  { entity: 'person', prefix: 'person.', scopes: ['worker'] },
] as const satisfies ReadonlyArray<{ entity: string; prefix: string; scopes: readonly RequirementScope[] }>;
