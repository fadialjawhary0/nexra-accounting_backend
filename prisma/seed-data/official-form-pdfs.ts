import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PDFDocument, PDFHexString, PDFName, rgb, type PDFPage } from 'pdf-lib';

/*
 * The example forms that ship with the system: made-up fillable PDFs shaped like the forms the office files (the questions are the ones its documents describe), so the
 * library, the mapping editor and the fill-in screens work from the first day. They are NOT the official forms — each says so on its first page; the office uploads the
 * official PDF of the tax authority as a new edition of the form.
 */

export type SampleField =
  | { kind: 'text'; name: string; label: string; tooltip?: string; multiline?: boolean; maxLength?: number; half?: boolean }
  | { kind: 'checkbox'; name: string; label: string; tooltip?: string }
  | { kind: 'radio'; name: string; label: string; options: string[]; tooltip?: string }
  | { kind: 'dropdown'; name: string; label: string; options: string[]; tooltip?: string };

export interface SampleSection {
  title: string;
  fields: SampleField[];
}

export interface SampleForm {
  title: string;
  code: string;
  sections: SampleSection[];
}

const PAGE = { width: 595, height: 842 };
const LEFT = 50;
const FIELD_X = 258;
const FIELD_WIDTH = 287;
const NAVY = rgb(0.059, 0.09, 0.165);
const MUTED = rgb(0.29, 0.29, 0.29);
const LINE = rgb(0.82, 0.8, 0.74);
const WARNING = rgb(0.56, 0.39, 0.13);

const fonts = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfmake/package.json')), 'fonts', 'Roboto');

export async function buildSampleForm(spec: SampleForm): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(await readFile(path.join(fonts, 'Roboto-Regular.ttf')), { subset: true });
  const bold = await doc.embedFont(await readFile(path.join(fonts, 'Roboto-Medium.ttf')), { subset: true });
  const form = doc.getForm();

  let page: PDFPage = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - 50;

  // The first page says what this is.
  page.drawRectangle({ x: LEFT, y: y - 46, width: PAGE.width - 2 * LEFT, height: 52, color: rgb(0.98, 0.96, 0.9), borderColor: rgb(0.94, 0.9, 0.78), borderWidth: 0.8 });
  page.drawText('VOORBEELDFORMULIER', { x: LEFT + 12, y: y - 14, size: 9, font: bold, color: WARNING });
  page.drawText('Dit is een voorbeeld dat met het systeem wordt meegeleverd, niet het officiële formulier.', { x: LEFT + 12, y: y - 28, size: 8.5, font: regular, color: MUTED });
  page.drawText('Upload het officiële PDF van de Belastingdienst als nieuwe versie van dit formulier.', { x: LEFT + 12, y: y - 40, size: 8.5, font: regular, color: MUTED });
  y -= 78;
  page.drawText(spec.title, { x: LEFT, y, size: 17, font: bold, color: NAVY });
  y -= 16;
  page.drawText(spec.code, { x: LEFT, y, size: 9, font: regular, color: MUTED });
  y -= 30;

  const newPage = () => {
    page = doc.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - 56;
  };
  const room = (height: number) => {
    if (y - height < 60) newPage();
  };
  const tooltip = (name: string, text: string | undefined) => {
    if (text) form.getField(name).acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(text));
  };

  for (const section of spec.sections) {
    room(60);
    page.drawText(section.title, { x: LEFT, y, size: 11, font: bold, color: NAVY });
    page.drawLine({ start: { x: LEFT, y: y - 5 }, end: { x: PAGE.width - LEFT, y: y - 5 }, thickness: 0.7, color: LINE });
    y -= 26;
    for (const field of section.fields) {
      const height = field.kind === 'text' && field.multiline ? 54 : 18;
      room(height + 14);
      // The label sits at the baseline of the first line of the field.
      page.drawText(field.label, { x: LEFT, y: y - 12, size: 9.5, font: regular, color: NAVY, maxWidth: FIELD_X - LEFT - 12 });
      if (field.kind === 'text') {
        const box = form.createTextField(field.name);
        if (field.maxLength) box.setMaxLength(field.maxLength);
        if (field.multiline) box.enableMultiline();
        box.addToPage(page, { x: FIELD_X, y: y - height + 2, width: field.half ? 140 : FIELD_WIDTH, height, borderColor: LINE, borderWidth: 0.8, textColor: NAVY });
      } else if (field.kind === 'checkbox') {
        const box = form.createCheckBox(field.name);
        box.addToPage(page, { x: FIELD_X, y: y - 14, width: 14, height: 14, borderColor: LINE, borderWidth: 0.8 });
      } else if (field.kind === 'radio') {
        const group = form.createRadioGroup(field.name);
        let x = FIELD_X;
        for (const option of field.options) {
          const width = regular.widthOfTextAtSize(option, 9) + 24;
          if (x + width > PAGE.width - LEFT) {
            x = FIELD_X;
            y -= 18;
            room(24);
          }
          group.addOptionToPage(option, page, { x, y: y - 14, width: 13, height: 13, borderColor: LINE, borderWidth: 0.8 });
          page.drawText(option, { x: x + 18, y: y - 11, size: 9, font: regular, color: NAVY });
          x += width + 8;
        }
      } else {
        const list = form.createDropdown(field.name);
        list.addOptions(field.options);
        list.addToPage(page, { x: FIELD_X, y: y - 16, width: 200, height: 18, borderColor: LINE, borderWidth: 0.8, textColor: NAVY });
      }
      tooltip(field.name, field.tooltip ?? field.label);
      y -= height + 12;
    }
    y -= 8;
  }

  // The page numbers.
  doc.getPages().forEach((each, index) => each.drawText(`Pagina ${index + 1} van ${doc.getPageCount()}`, { x: PAGE.width - LEFT - 70, y: 28, size: 8, font: regular, color: MUTED }));
  doc.setTitle(`${spec.title} (voorbeeld)`);
  doc.setProducer('Nexra B.V.');
  return Buffer.from(await doc.save());
}
