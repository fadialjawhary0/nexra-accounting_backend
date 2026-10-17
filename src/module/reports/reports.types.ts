import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { ExportFormat, ExportTable } from '../../lib/exports/export.types.js';

export interface Named {
  nl: string;
  en: string;
}

/** The inputs of a report, as the report page draws them. */
export type ReportParam =
  /** A fixed list of choices (`clearable` without a default). */
  | { key: string; type: 'select'; label: Named; options: Array<{ value: string; label: Named }>; default?: string }
  /** A client (the page offers the clients of the office). */
  | { key: string; type: 'client'; label: Named }
  /** A period: one of the ready-made ones (this month, last quarter …) or `custom` with `from` and `to` days. */
  | { key: string; type: 'period'; label: Named; options: string[]; default: string };

export type ReportGroup = 'lists' | 'money' | 'taxes' | 'control';

export interface ReportSummaryItem {
  label: string;
  value: string | number;
  format?: 'number' | 'money' | 'text';
  tone?: 'danger' | 'warning' | 'success' | 'info';
}

export interface ReportChart {
  type: 'bar';
  categories: string[];
  horizontal?: boolean;
  stacked?: boolean;
  series: Array<{ name: string; data: number[]; money?: boolean; tone?: 'brand' | 'danger' }>;
}

/** What a report produces: the table (also what is exported), and optionally a few numbers and a chart for the screen. */
export interface ReportOutput {
  table: ExportTable;
  summary?: ReportSummaryItem[];
  chart?: ReportChart | null;
}

export interface ReportRunInput {
  /** The values of the report's params (`client`, `period`, `from`, `to`, …), as they were typed. */
  params: Record<string, string>;
  user: AuthenticatedUser;
  locale: AppLocale;
  /** What the table is for: the screen (`screen`) or a file of this format (some lists have more columns in Excel than a page can hold). */
  format: ExportFormat | 'screen';
}

export interface ReportDefinition {
  key: string;
  group: ReportGroup;
  /** The permission area a person needs to open the report (`<area>.view`). */
  area: string;
  /** More areas that are needed (wages need `salary_statements`). */
  alsoNeeds?: string[];
  names: Named;
  descriptions: Named;
  params: ReportParam[];
  run(input: ReportRunInput): Promise<ReportOutput>;
}
