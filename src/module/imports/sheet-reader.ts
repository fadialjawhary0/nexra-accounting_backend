import { UnprocessableEntityException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } from './imports.constants.js';
import { cellText, isBlank, parseDutchDate, parseDutchNumber } from './value-coercion.js';

/** One sheet of a workbook (or the whole of a CSV file): the cells as plain values (text, numbers, dates, yes / no), row by row. */
export interface RawSheet {
  name: string;
  rows: unknown[][];
}

const unreadable = (code: string) => new UnprocessableEntityException({ code, message: 'The spreadsheet could not be read.' });

/** An Excel cell value as a plain value: formulas give their result, rich text its text, links their label. */
function plain(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    const object = value as unknown as Record<string, unknown>;
    if ('result' in object) return plain(object.result as ExcelJS.CellValue);
    if ('richText' in object && Array.isArray(object.richText)) return (object.richText as Array<{ text?: string }>).map(part => part.text ?? '').join('');
    if ('text' in object) return typeof object.text === 'string' ? object.text : plain(object.text as ExcelJS.CellValue);
    if ('error' in object) return null;
  }
  return null;
}

/** Rows without a single value at the end of a sheet (Excel remembers formatted-but-empty rows) are dropped. */
function trim(rows: unknown[][]): unknown[][] {
  let last = rows.length;
  while (last > 0 && rows[last - 1]!.every(cell => isBlank(cell))) last -= 1;
  return rows.slice(0, last);
}

async function readXlsx(bytes: Buffer): Promise<RawSheet[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw unreadable('import_sheet_unreadable');
  }
  const sheets: RawSheet[] = [];
  workbook.eachSheet(worksheet => {
    if (worksheet.state === 'veryHidden') return;
    const rows: unknown[][] = [];
    const width = Math.min(worksheet.columnCount, MAX_SHEET_COLUMNS);
    const height = Math.min(worksheet.rowCount, MAX_SHEET_ROWS + 50);
    for (let index = 1; index <= height; index += 1) {
      const row = worksheet.getRow(index);
      const cells: unknown[] = [];
      for (let column = 1; column <= width; column += 1) cells.push(plain(row.getCell(column).value));
      rows.push(cells);
    }
    sheets.push({ name: worksheet.name, rows: trim(rows) });
  });
  return sheets;
}

/* ── CSV ──────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** UTF-8 (with or without a byte-order mark) when the bytes are valid UTF-8, otherwise Windows-1252, which is what Excel saves a Dutch CSV in. */
function decodeText(bytes: Buffer): string {
  const text = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(text);
  } catch {
    return new TextDecoder('windows-1252').decode(text);
  }
}

/** The separator that splits the first lines into the same number of pieces most consistently (Dutch Excel uses `;`). */
function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter(line => line.trim()).slice(0, 8);
  let best = ';';
  let bestScore = -1;
  for (const delimiter of [';', ',', '\t', '|']) {
    const counts = lines.map(line => {
      let inside = false;
      let count = 0;
      for (const character of line) {
        if (character === '"') inside = !inside;
        else if (character === delimiter && !inside) count += 1;
      }
      return count;
    });
    const first = counts[0] ?? 0;
    const score = first === 0 ? 0 : counts.filter(count => count === first).length * 100 + first;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

/** RFC 4180: quoted fields may hold separators, line breaks and doubled quotes. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"' && field === '') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > MAX_SHEET_ROWS + 50) break;
    } else {
      field += character;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readCsv(bytes: Buffer, name: string): RawSheet[] {
  const text = decodeText(bytes);
  const rows = parseCsv(text, detectDelimiter(text)).map(row => row.slice(0, MAX_SHEET_COLUMNS).map(cell => (cell.trim() === '' ? null : cell.trim())));
  return [{ name, rows: trim(rows) }];
}

/** Reads every sheet of an `.xlsx` workbook, or a `.csv` / `.txt` file as one sheet. */
export async function readSheets(bytes: Buffer, extension: string, fileName: string): Promise<RawSheet[]> {
  const sheets = extension === 'xlsx' ? await readXlsx(bytes) : readCsv(bytes, fileName.replace(/\.[^.]+$/, '') || 'CSV');
  const filled = sheets.filter(sheet => sheet.rows.length > 0);
  if (!filled.length) throw unreadable('import_sheet_empty');
  return filled;
}

/* ── Headers ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

const looksLikeData = (cell: unknown): boolean => cell instanceof Date || typeof cell === 'number' || (typeof cell === 'string' && (parseDutchDate(cell) !== null || (parseDutchNumber(cell) !== null && /\d/.test(cell) && !/[a-z]/i.test(cell))));

/**
 * The row the column headings are on (0-based): the first of the top rows that has nearly as many text cells as the best one — a title above
 * the table ("KLANTEN 2026") has one cell and is skipped.
 */
export function detectHeaderRow(rows: unknown[][]): number {
  const limit = Math.min(rows.length, 30);
  const scores = Array.from({ length: limit }, (_, index) => rows[index]!.filter(cell => !isBlank(cell) && !looksLikeData(cell)).length);
  const best = Math.max(0, ...scores);
  if (best < 2) return 0;
  const index = scores.findIndex(score => score >= Math.ceil(best * 0.7));
  return index < 0 ? 0 : index;
}

/** The headings of a sheet: trimmed text, an empty one named after its column ("Kolom C"), a repeated one numbered ("Telefoon 2"). */
export function headersOf(rows: unknown[][], headerRow: number): string[] {
  const row = rows[headerRow] ?? [];
  const width = Math.max(row.length, ...rows.slice(headerRow + 1, headerRow + 40).map(other => other.length));
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, column) => {
    const text = cellText(row[column]);
    const base = text && !isBlank(text) ? text : `Kolom ${columnLetter(column)}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count > 1 ? `${base} ${count}` : base;
  });
}

export function columnLetter(index: number): string {
  let letters = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) letters = String.fromCharCode(65 + ((value - 1) % 26)) + letters;
  return letters;
}
