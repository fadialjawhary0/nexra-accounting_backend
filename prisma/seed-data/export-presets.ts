/**
 * Ready-made exports of the reports centre — what the office's sheets do by hand today. The names are Dutch (the office's language); the office changes or removes them in
 * Settings → Export presets. A relative period ("last month") moves along with the calendar, so these stay right next month.
 */
export interface SeedExportPreset {
  name: string;
  reportKey: string;
  format: 'xlsx' | 'pdf' | 'docx';
  /** `none` or one of the ready-made periods of the report page. */
  period: string;
  /** The other choices of the report page, by parameter key. */
  params: Record<string, string>;
}

export const SEED_EXPORT_PRESETS: SeedExportPreset[] = [
  { name: 'Contracten die aflopen — komende 90 dagen (Excel)', reportKey: 'contract-expiries', format: 'xlsx', period: 'next_90', params: {} },
  { name: 'Ontbrekende en verlopen documenten (PDF)', reportKey: 'documents-attention', format: 'pdf', period: 'none', params: {} },
  { name: 'Uren vorige maand (Excel)', reportKey: 'hours', format: 'xlsx', period: 'last_month', params: {} },
  { name: 'Loonstaten vorige maand (Excel)', reportKey: 'salary-statements', format: 'xlsx', period: 'last_month', params: {} },
  { name: 'Openstaande facturen aan klanten (Excel)', reportKey: 'invoices', format: 'xlsx', period: 'all', params: { direction: 'outgoing', open: 'true' } },
];
