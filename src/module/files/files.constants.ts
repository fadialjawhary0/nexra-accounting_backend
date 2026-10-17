import { matrixAllows, type PermissionMatrix } from '../roles/permission-catalog.js';

/*
 * What may be uploaded, and what an upload is for. The browser's idea of a file's type is never trusted: the extension decides
 * the type, and the file's first bytes must fit it (a `.pdf` that is really an executable is refused).
 */

interface FileType {
  mime: string;
  /** Checks the first bytes of the file. */
  matches: (head: Buffer) => boolean;
  /** Safe to show inside the browser (PDF, images). Everything else is always downloaded. */
  inline?: boolean;
}

const startsWith =
  (...bytes: number[]) =>
  (head: Buffer): boolean =>
    bytes.every((byte, index) => head[index] === byte);

const PDF = startsWith(0x25, 0x50, 0x44, 0x46, 0x2d); // %PDF-
const PNG = startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = startsWith(0xff, 0xd8, 0xff);
const GIF = startsWith(0x47, 0x49, 0x46, 0x38); // GIF8
const WEBP = (head: Buffer): boolean => head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
/** docx · xlsx · pptx · odt · ods are zip containers. */
const ZIP = startsWith(0x50, 0x4b, 0x03, 0x04);
/** doc · xls · ppt · msg are OLE compound files. */
const OLE = startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const RTF = (head: Buffer): boolean => head.subarray(0, 5).toString('latin1') === '{\\rtf';
/** Plain text has no NUL bytes. */
const TEXT = (head: Buffer): boolean => !head.includes(0);

export const FILE_TYPES: Record<string, FileType> = {
  pdf: { mime: 'application/pdf', matches: PDF, inline: true },
  png: { mime: 'image/png', matches: PNG, inline: true },
  jpg: { mime: 'image/jpeg', matches: JPEG, inline: true },
  jpeg: { mime: 'image/jpeg', matches: JPEG, inline: true },
  webp: { mime: 'image/webp', matches: WEBP, inline: true },
  gif: { mime: 'image/gif', matches: GIF, inline: true },
  doc: { mime: 'application/msword', matches: OLE },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', matches: ZIP },
  xls: { mime: 'application/vnd.ms-excel', matches: OLE },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', matches: ZIP },
  ppt: { mime: 'application/vnd.ms-powerpoint', matches: OLE },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', matches: ZIP },
  odt: { mime: 'application/vnd.oasis.opendocument.text', matches: ZIP },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', matches: ZIP },
  rtf: { mime: 'application/rtf', matches: RTF },
  msg: { mime: 'application/vnd.ms-outlook', matches: OLE },
  eml: { mime: 'message/rfc822', matches: TEXT },
  csv: { mime: 'text/csv', matches: TEXT },
  txt: { mime: 'text/plain', matches: TEXT },
};

/** The kinds of file Settings → Security policy can switch off (PDF is always allowed). */
export const FILE_KIND_SETTINGS: Record<string, readonly string[]> = {
  uploadAllowImages: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
  uploadAllowOffice: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'rtf'],
  uploadAllowEmail: ['msg', 'eml'],
  uploadAllowText: ['csv', 'txt'],
};

const IMAGES = ['png', 'jpg', 'jpeg', 'webp'] as const;
const DOCUMENTS = Object.keys(FILE_TYPES);

/** Where a file is stored on screen: the permission area that guards it. `null` = every signed-in person may open it. */
export interface FilePurpose {
  /** Permission needed to upload — or `area` when it is the create / edit permission of the area the file belongs to. */
  upload: string;
  /** `request` = the uploader names the area (an attachment); a permission area (`contracts`) = every file of this purpose belongs to it; `null` = no area. */
  area: string | null;
  extensions: readonly string[];
  /** A tighter limit than Settings → Security → upload limit. */
  maxMegabytes?: number;
  /** Made by the system itself (a generated contract): it cannot be uploaded through `POST /files`. */
  internal?: boolean;
}

export const FILE_PURPOSES: Record<string, FilePurpose> = {
  /** The office logo (Settings → Office) — shown in the app, on letters and on exports. SVG is left out on purpose. */
  office_logo: { upload: 'settings.edit', area: null, extensions: IMAGES, maxMegabytes: 2 },
  /** A document or photo on a record (a form's file field, a client's documents). */
  attachment: { upload: 'area', area: 'request', extensions: DOCUMENTS },
  /** A Word template with merge fields (Templates). Only people who manage templates open it. */
  template: { upload: 'templates.create', area: 'templates', extensions: ['docx'], maxMegabytes: 10 },
  /** The signed copy of a contract (a scan or a photo). */
  contract_scan: { upload: 'contracts.edit', area: 'contracts', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'docx'] },
  /** A contract or letter the system made from a template (Word and PDF). */
  contract_document: { upload: 'contracts.edit', area: 'contracts', extensions: ['docx', 'pdf'], internal: true },
  /** A salary statement the system made from a template (Word and PDF). Amounts are in it, so it follows the salary-statement permission. */
  salary_statement: { upload: 'salary_statements.create', area: 'salary_statements', extensions: ['docx', 'pdf'], internal: true },
  /** An invoice about hours: the PDF a staffing company sent (uploaded), or the Word and PDF the system made from the invoice template. */
  invoice_document: { upload: 'invoices.create', area: 'invoices', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'docx', 'xlsx'] },
  /** A file an import is reading (a spreadsheet, a scan, a photo): only people who work with imports open it. Once it is filed it becomes an ordinary document of a client or worker. */
  import_source: { upload: 'imports.create', area: 'imports', extensions: DOCUMENTS, internal: true },
  /** The blank PDF of an official form of the library. Only people who manage the library open it. */
  form_blank: { upload: 'official_forms.edit', area: 'official_forms', extensions: ['pdf'], maxMegabytes: 25 },
  /** A form that was filled in for a client: a document of the client, filed with its other documents. */
  form_document: { upload: 'official_forms.create', area: 'clients', extensions: ['pdf'], internal: true },
  /** The same with sensitive values in it (a BSN): only people who may see sensitive data open it. */
  form_document_personal: { upload: 'official_forms.create', area: 'personal_data', extensions: ['pdf'], internal: true },
};

/** The purposes a person can upload for through `POST /files`. */
export const FILE_PURPOSE_KEYS = Object.keys(FILE_PURPOSES).filter(key => !FILE_PURPOSES[key]?.internal);

/**
 * The purposes whose files are *documents*: they show in the Documents page, are found by the content search and are watched for their validity.
 * (The logo, the Word templates and the files an import is still reading are not.)
 */
export const DOCUMENT_PURPOSES: readonly string[] = ['attachment', 'contract_scan', 'contract_document', 'salary_statement', 'invoice_document', 'form_document', 'form_document_personal'];

/** The queue that reads the text of documents for the content search. */
export const DOCUMENT_INDEX_QUEUE = 'document-index';

/** The permission areas that guard documents (of a client, of a worker, copies of IDs, contracts, invoices, pay): a document is only seen by people who may view its area. */
export const DOCUMENT_AREAS: readonly string[] = ['clients', 'employees', 'personal_data', 'contracts', 'invoices', 'salary_statements'];

/** The areas of documents a person may open. */
export const viewableAreas = (matrix: PermissionMatrix): string[] => DOCUMENT_AREAS.filter(area => matrixAllows(matrix, `${area}.view`));

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};
