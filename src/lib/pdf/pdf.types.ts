/** The kinds of field an AcroForm PDF has that can be filled in (a push button or a signature box cannot). */
export type PdfFieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'signature' | 'button' | 'other';

/**
 * A rectangle on a page, in points, measured from the top left corner of the page as it is shown (its crop box) — the way a person sees the page and a screen draws it.
 * `PdfService` turns it into the PDF's own coordinates (from the bottom left) when it writes.
 */
export interface PdfBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One field of a PDF form, as found in the file — or a box placed on the page of a PDF without fields (`placed`). */
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
  /** Where the field is on its page (its first widget); null when it is on no page. */
  box: PdfBox | null;
  /** A box placed on the page by a person or the AI: its value is written onto the page, because the PDF has no field there. */
  placed: boolean;
  /** Placed text boxes: the value is written one character per cell (a row of letter boxes, such as a BSN in nine squares); null = one line of text. */
  cells: number | null;
  /** The words printed next to the field on the page (its question), found when the PDF was uploaded; empty when there are none. */
  context: string;
}

export interface PdfFormInfo {
  pageCount: number;
  /** The size of each page in points, as it is shown (its crop box). */
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
  /** Boxes placed on the pages (a PDF without fields): a value for one of these names is written onto the page instead of into a field. */
  placed?: PdfFieldInfo[];
}

/** A line of text on a page, measured like a `PdfBox`. */
export interface PdfTextLine {
  text: string;
  box: PdfBox;
  size: number;
}

/**
 * A place on a page where something can be written, found in the drawing of the page: an empty rectangle (`box`), a row of equal small squares (`cells`, a number
 * written one digit per square), a small square (`tick`, a check box) or a line to write on (`line`).
 */
export interface PdfArea {
  kind: 'box' | 'cells' | 'tick' | 'line';
  box: PdfBox;
  /** `cells`: how many squares. */
  cells: number;
}

/** What is on a page — its size, its lines of text and the places to write — for finding the questions of a PDF without fields. */
export interface PdfPageLayout {
  page: number;
  width: number;
  height: number;
  lines: PdfTextLine[];
  areas: PdfArea[];
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

export type PdfErrorCode = 'pdf_encrypted' | 'pdf_unreadable' | 'pdf_no_fields' | 'pdf_dynamic_form';

/** Something about a PDF the system cannot work with: `code` is also the translation key of the message. */
export class PdfError extends Error {
  constructor(readonly code: PdfErrorCode) {
    super(code);
    this.name = 'PdfError';
  }
}
