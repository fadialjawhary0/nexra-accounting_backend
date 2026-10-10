import { createRequire } from 'node:module';
import path from 'node:path';
import pdfmake, { type Content } from 'pdfmake';
import { WORDS, columnShares, formatCell, formatDay } from './export-format.js';
import type { ExportBranding, ExportTable } from './export.types.js';

type DocumentDefinition = Parameters<typeof pdfmake.createPdf>[0];

const NAVY = '#0F172A';
const GOLD = '#DCA54A';
const STRIPE = '#F7F5EF';

// Roboto ships with pdfmake; regular + medium (as bold) + italic. It has the euro sign and every Dutch letter.
const fontDirectory = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfmake/package.json')), 'fonts', 'Roboto');
pdfmake.setFonts({
  Roboto: {
    normal: path.join(fontDirectory, 'Roboto-Regular.ttf'),
    bold: path.join(fontDirectory, 'Roboto-Medium.ttf'),
    italics: path.join(fontDirectory, 'Roboto-Italic.ttf'),
    bolditalics: path.join(fontDirectory, 'Roboto-MediumItalic.ttf'),
  },
});

export async function writePdf(table: ExportTable, branding: ExportBranding): Promise<Buffer> {
  const words = WORDS[table.locale];
  const landscape = table.columns.length > 6;
  const header = table.columns.map(column => ({ text: column.header, bold: true, color: '#FFFFFF', fillColor: NAVY, alignment: column.type === 'number' || column.type === 'money' ? ('right' as const) : ('left' as const) }));
  const body = table.rows.map(row =>
    table.columns.map(column => ({ text: formatCell(row[column.key], column.type, table.locale), alignment: column.type === 'number' || column.type === 'money' ? ('right' as const) : ('left' as const) })),
  );
  // Column widths in points: the page's usable width (minus the padding every cell adds) shared by what each column needs.
  const CELL_PADDING = 10;
  const usable = (landscape ? 842 : 595) - 60 - table.columns.length * CELL_PADDING;
  const widths = columnShares(table.columns).map(share => Math.floor((usable * share) / 100));
  const stamp = `${words.generated} ${formatDay(branding.generatedAt)} ${words.by} ${branding.generatedBy}`;

  const content: Content[] = [
    ...(branding.logo ? [{ image: `data:${branding.logo.mimeType};base64,${branding.logo.data.toString('base64')}`, fit: [110, 36] as [number, number], margin: [0, 0, 0, 8] as [number, number, number, number] }] : []),
    { text: table.title, fontSize: 16, bold: true, color: NAVY },
    ...(table.subtitle ? [{ text: table.subtitle, fontSize: 9.5, color: '#4A4A4A', margin: [0, 2, 0, 0] as [number, number, number, number] }] : []),
    { text: `${table.rows.length} ${words.rows}`, fontSize: 8, color: '#6B6B6B', margin: [0, 2, 0, 10] },
    table.rows.length
      ? {
          table: { headerRows: 1, widths: widths, body: [header, ...body] },
          layout: {
            hLineWidth: (index: number, node: { table: { body: unknown[] } }) => (index === 0 || index === node.table.body.length ? 0 : 0.4),
            vLineWidth: () => 0,
            hLineColor: () => '#E2E0D8',
            fillColor: (rowIndex: number) => (rowIndex > 0 && rowIndex % 2 === 0 ? STRIPE : null),
            paddingTop: () => 4,
            paddingBottom: () => 4,
            paddingLeft: () => 5,
            paddingRight: () => 5,
          },
        }
      : { text: words.none, italics: true, color: '#6B6B6B' },
  ];

  const definition: DocumentDefinition = {
    pageSize: 'A4',
    pageOrientation: landscape ? 'landscape' : 'portrait',
    pageMargins: [30, 52, 30, 44],
    defaultStyle: { font: 'Roboto', fontSize: 8.5, color: '#222222' },
    info: { title: table.title, author: branding.organization, creator: 'Nexra B.V.' },
    header: { columns: [{ text: branding.organization, bold: true, fontSize: 9, color: NAVY }, { text: table.title, alignment: 'right', fontSize: 9, color: '#6B6B6B' }], margin: [30, 22, 30, 0] },
    footer: (page: number, pages: number) => ({
      columns: [{ text: stamp, fontSize: 7.5, color: '#6B6B6B' }, { text: `${words.page} ${page} ${words.of} ${pages}`, alignment: 'right', fontSize: 7.5, color: '#6B6B6B' }],
      margin: [30, 0, 30, 20],
    }),
    content,
  };
  // A thin gold line under the page header.
  definition.background = () => ({ canvas: [{ type: 'line', x1: 30, y1: 38, x2: landscape ? 811 : 565, y2: 38, lineWidth: 0.8, lineColor: GOLD }] });

  return Buffer.from(await pdfmake.createPdf(definition).getBuffer());
}
