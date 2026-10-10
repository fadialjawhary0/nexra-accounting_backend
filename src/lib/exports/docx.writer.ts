import { AlignmentType, BorderStyle, Document, Footer, Header, ImageRun, Packer, PageNumber, PageOrientation, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType } from 'docx';
import { WORDS, columnShares, formatCell, formatDay } from './export-format.js';
import type { ColumnType, ExportBranding, ExportTable } from './export.types.js';

const NAVY = '0F172A';
const GOLD = 'DCA54A';
const STRIPE = 'F7F5EF';
const FONT = 'Calibri';
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const HAIRLINE = { style: BorderStyle.SINGLE, size: 4, color: 'E2E0D8' };

const run = (text: string, options: { bold?: boolean; size?: number; color?: string } = {}) => new TextRun({ text, font: FONT, size: options.size ?? 18, bold: options.bold, color: options.color });

export async function writeDocx(table: ExportTable, branding: ExportBranding): Promise<Buffer> {
  const words = WORDS[table.locale];
  const landscape = table.columns.length > 6;
  const shares = columnShares(table.columns);
  const percent = (column: ExportTable['columns'][number]) => shares[table.columns.indexOf(column)] ?? 10;
  const alignment = (type?: ColumnType) => (type === 'number' || type === 'money' ? AlignmentType.RIGHT : AlignmentType.LEFT);

  const headerRow = new TableRow({
    tableHeader: true,
    children: table.columns.map(
      column =>
        new TableCell({
          width: { size: percent(column), type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.CLEAR, fill: NAVY, color: 'auto' },
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 70, bottom: 70, left: 90, right: 90 },
          children: [new Paragraph({ alignment: alignment(column.type), children: [run(column.header, { bold: true, color: 'FFFFFF' })] })],
        }),
    ),
  });
  const bodyRows = table.rows.map(
    (row, index) =>
      new TableRow({
        cantSplit: true,
        children: table.columns.map(
          column =>
            new TableCell({
              width: { size: percent(column), type: WidthType.PERCENTAGE },
              shading: index % 2 === 1 ? { type: ShadingType.CLEAR, fill: STRIPE, color: 'auto' } : undefined,
              margins: { top: 50, bottom: 50, left: 90, right: 90 },
              borders: { top: NONE, left: NONE, right: NONE, bottom: HAIRLINE },
              children: [new Paragraph({ alignment: alignment(column.type), children: [run(formatCell(row[column.key], column.type, table.locale))] })],
            }),
        ),
      }),
  );

  const logo = branding.logo
    ? [new Paragraph({ spacing: { after: 120 }, children: [new ImageRun({ type: branding.logo.mimeType === 'image/png' ? 'png' : 'jpg', data: branding.logo.data, transformation: { width: 110, height: 36 } })] })]
    : [];

  const document = new Document({
    creator: branding.organization,
    title: table.title,
    styles: { default: { document: { run: { font: FONT, size: 18 } } } },
    sections: [
      {
        properties: { page: { size: { orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT }, margin: { top: 1000, bottom: 900, left: 720, right: 720 } } },
        headers: {
          default: new Header({
            children: [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GOLD, space: 4 } }, children: [run(branding.organization, { bold: true, size: 18, color: NAVY }), run(`   ${table.title}`, { size: 18, color: '6B6B6B' })] })],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  run(`${words.generated} ${formatDay(branding.generatedAt)} ${words.by} ${branding.generatedBy}`, { size: 15, color: '6B6B6B' }),
                  new TextRun({ children: [`\t${words.page} `, PageNumber.CURRENT, ` ${words.of} `, PageNumber.TOTAL_PAGES], font: FONT, size: 15, color: '6B6B6B' }),
                ],
                tabStops: [{ type: 'right', position: landscape ? 15398 : 10466 }],
              }),
            ],
          }),
        },
        children: [
          ...logo,
          new Paragraph({ spacing: { after: 40 }, children: [run(table.title, { bold: true, size: 32, color: NAVY })] }),
          ...(table.subtitle ? [new Paragraph({ spacing: { after: 40 }, children: [run(table.subtitle, { size: 19, color: '4A4A4A' })] })] : []),
          new Paragraph({ spacing: { after: 200 }, children: [run(`${table.rows.length} ${words.rows}`, { size: 16, color: '6B6B6B' })] }),
          ...(table.rows.length ? [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] })] : [new Paragraph({ children: [run(words.none, { color: '6B6B6B' })] })]),
        ],
      },
    ],
  });
  return Packer.toBuffer(document);
}
