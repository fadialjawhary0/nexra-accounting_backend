import ExcelJS from 'exceljs';
import { WORDS, formatCell, toDate } from './export-format.js';
import type { ColumnType, ExportBranding, ExportColumn, ExportTable } from './export.types.js';

const NAVY = 'FF0F172A';
const GOLD = 'FFDCA54A';
const STRIPE = 'FFF7F5EF';
const DEFAULT_WIDTH: Record<ColumnType, number> = { text: 24, number: 12, money: 14, date: 12, datetime: 17, boolean: 8 };
/** The rows above the header: title, subtitle, "generated on …" and a blank line. */
const HEADER_ROW = 5;

/** Excel number formats (these codes work in every language of Excel). */
const NUMBER_FORMAT: Partial<Record<ColumnType, string>> = { number: '#,##0.######', money: '"€" #,##0.00', date: 'dd-mm-yyyy', datetime: 'dd-mm-yyyy hh:mm' };

/**
 * The cell value for Excel: numbers and dates stay numbers and dates (so people can sort, sum and filter), formatted with a number
 * format; everything else is text.
 */
function cellValue(value: unknown, column: ExportColumn, table: ExportTable): ExcelJS.CellValue {
  if (value === null || value === undefined || value === '') return null;
  const type = column.type ?? 'text';
  if ((type === 'number' || type === 'money') && typeof value === 'number') return value;
  if (type === 'date' || type === 'datetime') {
    const date = toDate(value);
    if (!date) return String(value);
    // Excel has no time zone: a day is shown as that day, a moment as Amsterdam wall-clock time.
    if (type === 'date') return typeof value === 'string' ? new Date(`${value}T00:00:00.000Z`) : new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    return new Date(date.getTime() + wallClockOffsetMs(date));
  }
  return formatCell(value, type, table.locale);
}

/** Milliseconds that turn a UTC moment into the same clock time as in Amsterdam (Excel stores wall-clock time). */
function wallClockOffsetMs(date: Date): number {
  const amsterdam = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  return amsterdam.getTime() - utc.getTime();
}

export async function writeXlsx(table: ExportTable, branding: ExportBranding): Promise<Buffer> {
  const words = WORDS[table.locale];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = branding.organization;
  workbook.created = branding.generatedAt;
  const sheet = workbook.addWorksheet(table.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Export', { views: [{ state: 'frozen', ySplit: HEADER_ROW }] });

  sheet.columns = table.columns.map(column => ({ key: column.key, width: column.width ?? DEFAULT_WIDTH[column.type ?? 'text'] }));
  sheet.getCell('A1').value = table.title;
  sheet.getCell('A1').font = { bold: true, size: 15, color: { argb: NAVY } };
  if (table.subtitle) sheet.getCell('A2').value = table.subtitle;
  sheet.getCell('A3').value = `${branding.organization} · ${words.generated} ${branding.generatedAt.toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' })} ${words.by} ${branding.generatedBy} · ${table.rows.length} ${words.rows}`;
  sheet.getCell('A2').font = { size: 11, color: { argb: 'FF4A4A4A' } };
  sheet.getCell('A3').font = { size: 9, color: { argb: 'FF6B6B6B' } };

  const header = sheet.getRow(HEADER_ROW);
  table.columns.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = column.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { vertical: 'middle', horizontal: column.type === 'number' || column.type === 'money' ? 'right' : 'left', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: GOLD } } };
  });
  header.height = 22;

  table.rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(HEADER_ROW + 1 + rowIndex);
    table.columns.forEach((column, index) => {
      const cell = excelRow.getCell(index + 1);
      cell.value = cellValue(row[column.key], column, table);
      const format = NUMBER_FORMAT[column.type ?? 'text'];
      if (format) cell.numFmt = format;
      cell.alignment = { vertical: 'top', horizontal: column.type === 'number' || column.type === 'money' ? 'right' : 'left', wrapText: column.type === 'text' || column.type === undefined };
      if (rowIndex % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STRIPE } };
    });
  });

  if (table.rows.length) sheet.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW + table.rows.length, column: table.columns.length } };
  sheet.pageSetup = { orientation: table.columns.length > 6 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
