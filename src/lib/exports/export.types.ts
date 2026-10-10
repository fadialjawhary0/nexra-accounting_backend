export type ExportFormat = 'xlsx' | 'pdf' | 'docx';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['xlsx', 'pdf', 'docx'];

export type ExportLocale = 'nl' | 'en';

/** How a column's values are shown: Dutch formats everywhere (`31-12-2026`, `€ 1.234,56`, `1.234,5`, Ja / Nee). */
export type ColumnType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'boolean';

export interface ExportColumn {
  key: string;
  header: string;
  type?: ColumnType;
  /** Rough width in characters (a hint for Excel and for the share of a page's width a column gets). */
  width?: number;
}

/**
 * Any list as a table: the feature builds one from its rows and columns, the export service writes it as Excel, PDF or Word.
 * Cell values are plain data — text, numbers, booleans, `Date`s or `YYYY-MM-DD` strings — never formatted text.
 */
export interface ExportTable {
  title: string;
  /** What the table contains: the filters and period used ("Status: active · January 2026"). */
  subtitle?: string;
  columns: ExportColumn[];
  rows: Array<Record<string, unknown>>;
  locale: ExportLocale;
}

export interface ExportBranding {
  organization: string;
  generatedBy: string;
  generatedAt: Date;
  /** The office logo (png / jpeg only: PDF and Word cannot embed WebP). */
  logo?: { data: Buffer; mimeType: 'image/png' | 'image/jpeg' };
}

export interface ExportFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export const EXPORT_MIME: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Longest list a single (synchronous) export holds. Bigger ones need a background job (Phase 11). */
export const MAX_EXPORT_ROWS = 20_000;
