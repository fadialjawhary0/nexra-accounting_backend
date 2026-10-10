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

const IMAGES = ['png', 'jpg', 'jpeg', 'webp'] as const;
const DOCUMENTS = Object.keys(FILE_TYPES);

/** Where a file is stored on screen: the permission area that guards it. `null` = every signed-in person may open it. */
export interface FilePurpose {
  /** Permission needed to upload — or `area` when it is the create / edit permission of the area the file belongs to. */
  upload: string;
  /** `request` = the uploader names the area (an attachment); otherwise the area is fixed (or none). */
  area: 'request' | null;
  extensions: readonly string[];
  /** A tighter limit than Settings → Security → upload limit. */
  maxMegabytes?: number;
}

export const FILE_PURPOSES: Record<string, FilePurpose> = {
  /** The office logo (Settings → Office) — shown in the app, on letters and on exports. SVG is left out on purpose. */
  office_logo: { upload: 'settings.edit', area: null, extensions: IMAGES, maxMegabytes: 2 },
  /** A document or photo on a record (a form's file field, a client's documents). */
  attachment: { upload: 'area', area: 'request', extensions: DOCUMENTS },
};

export const FILE_PURPOSE_KEYS = Object.keys(FILE_PURPOSES);

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};
