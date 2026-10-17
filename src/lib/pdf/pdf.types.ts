/** The kinds of field an AcroForm PDF has that can be filled in (a push button or a signature box cannot). */
export type PdfFieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'signature' | 'button' | 'other';

/** One field of a PDF form, as found in the file. */
export interface PdfFieldInfo {
  /** The full name of the field (`topmostSubform[0].Page1[0].Naam[0]`): what the mapping refers to. */
  name: string;
  kind: PdfFieldKind;
  /** The page (counting from 0) where the field is drawn first; -1 when it is on no page. */
  page: number;
  /** Radio buttons, drop-downs and lists: the values it can take. */
  options: string[];
  maxLength: number | null;
  multiline: boolean;
  readOnly: boolean;
  /** The text the author of the PDF gave the field as its alternative name (what it is for); empty when there is none. */
  tooltip: string;
}

export interface PdfFormInfo {
  pageCount: number;
  /** The size of each page in points. */
  pages: Array<{ width: number; height: number }>;
  fields: PdfFieldInfo[];
  /** The file is a dynamic (XFA) form too: the fields below are its classic form; the dynamic part is dropped when it is filled. */
  hasXfa: boolean;
}

/** What goes into a field: text, ticked or not, an option of a radio group / drop-down, several options of a list; `null` leaves it as it is. */
export type PdfFieldValue = string | boolean | string[] | null;

export interface PdfFillOptions {
  /** Make the result final: the fields become part of the page and can no longer be changed. */
  flatten?: boolean;
  title?: string;
}

export interface PdfFillResult {
  bytes: Buffer;
  /** Names the mapping mentions that the PDF does not have (the form was replaced by another edition). */
  unknown: string[];
  /** Fields whose text was longer than the field takes and was cut. */
  truncated: string[];
  /** Fields that could not be filled (an option the field does not offer …). */
  failed: Array<{ name: string; reason: 'option' | 'kind' | 'error' }>;
}

/** A block of text on a page, positioned in millimetres from the top left corner. */
export interface PdfTextBlock {
  lines: string[];
  xMm: number;
  yMm: number;
  sizePt: number;
  bold?: boolean;
  /** Line height as a multiple of the size (default 1.25). */
  leading?: number;
  /** `#RRGGBB`; default black. */
  color?: string;
}

/** A PDF that goes into a combined PDF, with the label put at the foot of each of its pages. */
export interface PdfPart {
  bytes: Buffer;
  label: string;
}

export type PdfErrorCode = 'pdf_encrypted' | 'pdf_unreadable' | 'pdf_no_fields';

/** Something about a PDF the system cannot work with: `code` is also the translation key of the message. */
export class PdfError extends Error {
  constructor(readonly code: PdfErrorCode) {
    super(code);
    this.name = 'PdfError';
  }
}
