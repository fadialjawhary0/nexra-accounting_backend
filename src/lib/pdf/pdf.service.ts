import fontkit from '@pdf-lib/fontkit';
import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  EncryptedPDFError,
  PDFBool,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFString,
  PDFTextField,
  rgb,
  type PDFField,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import { readLayout } from './pdf-layout.js';
import {
  PdfError,
  type PdfBox,
  type PdfFieldInfo,
  type PdfFieldKind,
  type PdfFieldValue,
  type PdfFillOptions,
  type PdfFillResult,
  type PdfFormInfo,
  type PdfPageLayout,
  type PdfPart,
  type PdfTextBlock,
} from './pdf.types.js';

const POINTS_PER_MM = 72 / 25.4;
const mm = (value: number): number => value * POINTS_PER_MM;

// Roboto ships with pdfmake; it has every Dutch letter and most European names (ł, ğ, ı, ş …) and the euro sign.
const FONT_DIRECTORY = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfmake/package.json')), 'fonts', 'Roboto');

const hexColor = (value: string | undefined) => {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value ?? '');
  return match ? rgb(parseInt(match[1]!, 16) / 255, parseInt(match[2]!, 16) / 255, parseInt(match[3]!, 16) / 255) : rgb(0, 0, 0);
};

/**
 * Everything the office does with PDF files it did not write itself: reading the fields of an official form, filling them in (with a font that has every
 * letter a Dutch name can hold, so a name is never cut or swapped for a question mark), and drawing small pages of text such as envelope labels.
 * It knows nothing about clients or forms of the office — that is `official-forms`.
 */
@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  private fonts: { regular: Buffer; bold: Buffer } | null = null;

  /* ── Reading a form ───────────────────────────────────────────────────────────────────────────────────────────── */

  /** The fields of a PDF form, in the order the file lists them. */
  async inspect(bytes: Buffer): Promise<PdfFormInfo> {
    const doc = await this.load(bytes);
    const form = doc.getForm();
    const pages = doc.getPages();
    const pageOfRef = new Map<string, number>();
    pages.forEach((page, index) => {
      pageOfRef.set(page.ref.tag, index);
      const annotations = page.node.Annots();
      for (let position = 0; annotations && position < annotations.size(); position += 1) {
        const entry = annotations.get(position);
        if (entry instanceof PDFRef) pageOfRef.set(`annot:${entry.tag}`, index);
      }
    });

    const fields = form.getFields().map((field): PdfFieldInfo => {
      const kind = this.kindOf(field);
      const page = this.pageOf(field, pageOfRef);
      return {
        name: field.getName(),
        kind,
        page,
        options: field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList ? this.safeOptions(field) : [],
        maxLength: field instanceof PDFTextField ? (field.getMaxLength() ?? null) : null,
        multiline: field instanceof PDFTextField ? field.isMultiline() : false,
        readOnly: field.isReadOnly(),
        tooltip: this.tooltipOf(field),
        box: page >= 0 ? this.boxOf(field, pages[page]!) : null,
        placed: false,
        cells: null,
        context: '',
      };
    });
    return {
      pageCount: pages.length,
      pages: pages.map(page => {
        const crop = page.getCropBox();
        return { width: Math.round(crop.width), height: Math.round(crop.height) };
      }),
      fields,
      hasXfa: form.acroForm.dict.has(PDFName.of('XFA')),
    };
  }

  /** Where the first widget of a field is on its page, measured from the top left corner of the page as it is shown. */
  private boxOf(field: PDFField, page: PDFPage): PdfBox | null {
    try {
      const widget = field.acroField.getWidgets()[0];
      if (!widget) return null;
      const rect = widget.getRectangle();
      const crop = page.getCropBox();
      const round = (value: number) => Math.round(value * 10) / 10;
      return { x: round(rect.x - crop.x), y: round(crop.y + crop.height - (rect.y + rect.height)), width: round(rect.width), height: round(rect.height) };
    } catch {
      return null;
    }
  }

  /** The lines of text and the places to write on the first pages — what a form without fields is read from. A PDF pdf.js cannot read gives no pages. */
  async layout(bytes: Buffer, maxPages = 12): Promise<PdfPageLayout[]> {
    try {
      return await readLayout(bytes, maxPages);
    } catch (error) {
      this.logger.debug(`The layout of a PDF could not be read: ${(error as Error).message}`);
      return [];
    }
  }

  private kindOf(field: PDFField): PdfFieldKind {
    if (field instanceof PDFTextField) return 'text';
    if (field instanceof PDFCheckBox) return 'checkbox';
    if (field instanceof PDFRadioGroup) return 'radio';
    if (field instanceof PDFDropdown) return 'dropdown';
    if (field instanceof PDFOptionList) return 'list';
    if (field instanceof PDFSignature) return 'signature';
    return field.constructor.name === 'PDFButton' ? 'button' : 'other';
  }

  private safeOptions(field: PDFRadioGroup | PDFDropdown | PDFOptionList): string[] {
    try {
      return field.getOptions();
    } catch {
      return [];
    }
  }

  private pageOf(field: PDFField, pageOfRef: Map<string, number>): number {
    for (const widget of field.acroField.getWidgets()) {
      const page = widget.P();
      if (page && pageOfRef.has(page.tag)) return pageOfRef.get(page.tag)!;
    }
    // Widgets without a page entry are found through the pages' annotation lists.
    const kids = field.acroField.Kids();
    const refs = [field.ref, ...(kids ? Array.from({ length: kids.size() }, (_unused, position) => kids.get(position)) : [])];
    for (const ref of refs) {
      if (ref instanceof PDFRef && pageOfRef.has(`annot:${ref.tag}`)) return pageOfRef.get(`annot:${ref.tag}`)!;
    }
    return -1;
  }

  private tooltipOf(field: PDFField): string {
    const entry = field.acroField.dict.get(PDFName.of('TU'));
    return entry instanceof PDFString || entry instanceof PDFHexString ? entry.decodeText().trim() : '';
  }

  /* ── Filling a form ───────────────────────────────────────────────────────────────────────────────────────────── */

  /** The PDF with the values in its fields. A name the PDF does not have is reported, never silently dropped. */
  async fill(bytes: Buffer, values: Record<string, PdfFieldValue>, options: PdfFillOptions = {}): Promise<PdfFillResult> {
    const doc = await this.load(bytes);
    doc.registerFontkit(fontkit);
    const form = doc.getForm();
    // A dynamic (XFA) form shows its own data instead of the classic fields; dropping it makes every viewer show what was filled in here.
    form.acroForm.dict.delete(PDFName.of('XFA'));
    const font = await doc.embedFont((await this.loadFonts()).regular, { subset: false });

    const unknown: string[] = [];
    const truncated: string[] = [];
    const failed: PdfFillResult['failed'] = [];
    const placed = new Map((options.placed ?? []).filter(box => box.placed && box.box && box.page >= 0 && box.page < doc.getPageCount()).map(box => [box.name, box]));
    for (const [name, value] of Object.entries(values)) {
      if (value === null) continue;
      const box = placed.get(name);
      if (box) {
        try {
          this.write(doc.getPage(box.page), box, value, font, truncated);
        } catch (error) {
          this.logger.debug(`Box ${name} could not be written: ${(error as Error).message}`);
          failed.push({ name, reason: 'error' });
        }
        continue;
      }
      const field = form.getFieldMaybe(name);
      if (!field) {
        unknown.push(name);
        continue;
      }
      try {
        const problem = this.put(field, value, truncated);
        if (problem) failed.push({ name, reason: problem });
      } catch (error) {
        this.logger.debug(`Field ${name} could not be filled: ${(error as Error).message}`);
        failed.push({ name, reason: 'error' });
      }
    }

    // The appearances drawn here are the ones to show: a viewer that redraws them from the field's own font would lose letters the standard fonts lack.
    // When one cannot be drawn (a broken widget) the viewer is asked to draw them after all, and the result cannot be made final.
    let drawn = true;
    try {
      form.updateFieldAppearances(font);
    } catch (error) {
      this.logger.debug(`Field appearances could not be drawn: ${(error as Error).message}`);
      drawn = false;
    }
    form.acroForm.dict.set(PDFName.of('NeedAppearances'), drawn ? PDFBool.False : PDFBool.True);
    if (options.flatten && drawn) form.flatten({ updateFieldAppearances: false });
    if (options.title) doc.setTitle(options.title);
    doc.setProducer('Nexra B.V.');
    doc.setModificationDate(new Date());
    return { bytes: Buffer.from(await doc.save()), unknown, truncated, failed };
  }

  /**
   * A value written onto the page in a placed box (the PDF has no field there): a cross in a tick box; in a row of letter boxes one character per box; otherwise one
   * line of text made smaller until it fits (never below 6 pt), or — for a box that takes several lines — the words wrapped over the lines that fit. What does not fit
   * is cut and reported.
   */
  private write(page: PDFPage, box: PdfFieldInfo, value: Exclude<PdfFieldValue, null>, font: PDFFont, truncated: string[]): void {
    const area = box.box!;
    const crop = page.getCropBox();
    const left = crop.x + area.x;
    const bottom = crop.y + crop.height - area.y - area.height;
    const ink = rgb(0.05, 0.05, 0.1);
    // Capital letters are about 0.7 of the size high: this puts a line of text in the middle of the box.
    const baselineFor = (size: number) => bottom + (area.height - size * 0.7) / 2;

    if (box.kind === 'checkbox') {
      const on = typeof value === 'boolean' ? value : Array.isArray(value) ? value.length > 0 : /^(1|true|yes|ja|x|on)$/i.test(value.trim());
      if (!on) return;
      const size = Math.max(6, Math.min(area.width, area.height) * 0.9);
      page.drawText('X', { x: left + (area.width - font.widthOfTextAtSize('X', size)) / 2, y: baselineFor(size), size, font, color: ink });
      return;
    }

    const text = (Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'X' : '') : value).replace(/\s+/g, ' ').trim();
    if (!text) return;

    if (box.cells && box.cells > 1) {
      const characters = Array.from(text.replace(/\s/g, ''));
      if (characters.length > box.cells) truncated.push(box.name);
      const cell = area.width / box.cells;
      const size = Math.max(6, Math.min(area.height * 0.72, cell * 1.05, 14));
      characters.slice(0, box.cells).forEach((character, index) => {
        page.drawText(character, { x: left + index * cell + (cell - font.widthOfTextAtSize(character, size)) / 2, y: baselineFor(size), size, font, color: ink });
      });
      return;
    }

    const padding = Math.min(3, area.width * 0.05);
    const room = area.width - padding * 2;
    if (box.multiline && area.height >= 22) {
      const size = 9;
      const lead = size * 1.25;
      const rows = Math.max(1, Math.floor((area.height - 2) / lead));
      const lines = this.wrap(font, text, size, room);
      if (lines.length > rows) truncated.push(box.name);
      lines.slice(0, rows).forEach((line, index) => page.drawText(line, { x: left + padding, y: bottom + area.height - 2 - size * 0.9 - index * lead, size, font, color: ink }));
      return;
    }
    let size = Math.max(6, Math.min(10, area.height * 0.72));
    while (size > 6 && font.widthOfTextAtSize(text, size) > room) size -= 0.5;
    let line = text;
    if (font.widthOfTextAtSize(line, size) > room) {
      while (line.length > 1 && font.widthOfTextAtSize(line, size) > room) line = line.slice(0, -1);
      truncated.push(box.name);
    }
    page.drawText(line, { x: left + padding, y: baselineFor(size), size, font, color: ink });
  }

  /** A text broken into lines that fit the width, at spaces where possible. */
  private wrap(font: PDFFont, text: string, size: number, width: number): string[] {
    const lines: string[] = [];
    let current = '';
    for (const word of text.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      // A word longer than the line is cut over several lines.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
        let cut = rest;
        while (cut.length > 1 && font.widthOfTextAtSize(cut, size) > width) cut = cut.slice(0, -1);
        lines.push(cut);
        rest = rest.slice(cut.length);
      }
      current = rest;
    }
    if (current) lines.push(current);
    return lines;
  }

  private put(field: PDFField, value: Exclude<PdfFieldValue, null>, truncated: string[]): 'option' | 'kind' | null {
    if (field instanceof PDFTextField) {
      const text = Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'X' : '') : value;
      const limit = field.getMaxLength();
      const cut = limit !== undefined && text.length > limit ? text.slice(0, limit) : text;
      if (cut !== text) truncated.push(field.getName());
      if (cut) field.setText(cut);
      else field.setText(undefined);
      return null;
    }
    if (field instanceof PDFCheckBox) {
      const on = typeof value === 'boolean' ? value : Array.isArray(value) ? value.length > 0 : /^(1|true|yes|ja|x|on)$/i.test(value.trim());
      if (on) field.check();
      else field.uncheck();
      return null;
    }
    if (field instanceof PDFRadioGroup) {
      const wanted = Array.isArray(value) ? (value[0] ?? '') : String(value);
      if (!wanted) {
        field.clear();
        return null;
      }
      const option = field.getOptions().find(entry => entry === wanted) ?? field.getOptions().find(entry => entry.trim().toLowerCase() === wanted.trim().toLowerCase());
      if (!option) return 'option';
      field.select(option);
      return null;
    }
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const wanted = (Array.isArray(value) ? value : [String(value)]).map(entry => String(entry)).filter(Boolean);
      if (!wanted.length) {
        field.clear();
        return null;
      }
      const have = field.getOptions();
      const picked = wanted.map(entry => have.find(option => option === entry) ?? have.find(option => option.trim().toLowerCase() === entry.trim().toLowerCase()));
      if (picked.some(entry => entry === undefined)) {
        // An editable drop-down may take any text.
        if (field instanceof PDFDropdown && field.isEditable()) {
          field.addOptions(wanted.filter(entry => !have.includes(entry)));
          field.select(wanted);
          return null;
        }
        return 'option';
      }
      field.select(picked as string[]);
      return null;
    }
    return 'kind';
  }

  /* ── Drawing text pages (envelope labels) ─────────────────────────────────────────────────────────────────────── */

  /** A one-page PDF of the given size with blocks of text on it. */
  async textPage(options: { widthMm: number; heightMm: number; blocks: PdfTextBlock[]; title?: string }): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const fonts = await this.loadFonts();
    const regular = await doc.embedFont(fonts.regular, { subset: true });
    const bold = await doc.embedFont(fonts.bold, { subset: true });
    const height = mm(options.heightMm);
    const page = doc.addPage([mm(options.widthMm), height]);
    for (const block of options.blocks) {
      const font = block.bold ? bold : regular;
      const lead = block.sizePt * (block.leading ?? 1.25);
      block.lines.forEach((line, index) => {
        if (!line) return;
        // The first line sits with its top at `yMm`; the baseline is a little below that.
        page.drawText(line, { x: mm(block.xMm), y: height - mm(block.yMm) - block.sizePt * 0.8 - index * lead, size: block.sizePt, font, color: hexColor(block.color) });
      });
    }
    doc.setTitle(options.title ?? '');
    doc.setProducer('Nexra B.V.');
    return Buffer.from(await doc.save());
  }

  /* ── Putting PDFs together (an inspection bundle) ─────────────────────────────────────────────────────────────── */

  /** How many pages a PDF has. */
  async pageCount(bytes: Buffer): Promise<number> {
    return (await this.load(bytes)).getPageCount();
  }

  /**
   * The pages of several PDFs one after the other, each page with a small label at the foot (which document it belongs to, its page of the document) and the number it has in
   * the whole (counted from `firstPage`, so the pages of an index put in front keep counting). A part that cannot be read (encrypted, damaged) throws a `PdfError` — the caller
   * decides whether to leave it out.
   */
  async combine(parts: PdfPart[], options: { firstPage: number; title?: string }): Promise<{ bytes: Buffer; counts: number[] }> {
    const out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    const font = await out.embedFont((await this.loadFonts()).regular, { subset: true });
    const counts: number[] = [];
    let number = options.firstPage;
    for (const part of parts) {
      const source = await this.load(part.bytes);
      const copied = await out.copyPages(source, source.getPageIndices());
      counts.push(copied.length);
      copied.forEach((page, index) => {
        out.addPage(page);
        // A rotated page would get a sideways label; those pages are left as they are.
        if (page.getRotation().angle === 0) {
          const { width } = page.getSize();
          const label = `${part.label}  ·  ${index + 1}/${copied.length}`;
          const size = 7;
          const fitted = this.fit(font, label, size, width - mm(34));
          page.drawText(fitted, { x: mm(10), y: mm(5), size, font, color: rgb(0.35, 0.35, 0.35) });
          const text = String(number);
          page.drawText(text, { x: width - mm(10) - font.widthOfTextAtSize(text, size), y: mm(5), size, font, color: rgb(0.35, 0.35, 0.35) });
        }
        number += 1;
      });
    }
    if (options.title) out.setTitle(options.title);
    out.setProducer('Nexra B.V.');
    return { bytes: Buffer.from(await out.save()), counts };
  }

  /** The text cut so it fits the width (with an ellipsis). */
  private fit(font: { widthOfTextAtSize(text: string, size: number): number }, text: string, size: number, maxWidth: number): string {
    if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) cut = cut.slice(0, -1);
    return `${cut}…`;
  }

  /** A PDF of one page that shows a picture (a photo of a document), as large as fits on A4 without being stretched. */
  async imagePage(bytes: Buffer, mime: 'image/png' | 'image/jpeg'): Promise<Buffer> {
    const doc = await PDFDocument.create();
    let image;
    try {
      image = mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    } catch {
      throw new PdfError('pdf_unreadable');
    }
    const landscape = image.width > image.height;
    const [pageWidth, pageHeight] = landscape ? [mm(297), mm(210)] : [mm(210), mm(297)];
    const margin = mm(12);
    const scale = Math.min((pageWidth - 2 * margin) / image.width, (pageHeight - 2 * margin) / image.height, 1);
    const page = doc.addPage([pageWidth, pageHeight]);
    page.drawImage(image, { x: (pageWidth - image.width * scale) / 2, y: (pageHeight - image.height * scale) / 2, width: image.width * scale, height: image.height * scale });
    doc.setProducer('Nexra B.V.');
    return Buffer.from(await doc.save());
  }

  /** Plain text on A4 pages (a text file that goes into a bundle), wrapped to the page and carried over to as many pages as it needs. */
  async textDocument(content: string, title: string): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const fonts = await this.loadFonts();
    const regular = await doc.embedFont(fonts.regular, { subset: true });
    const bold = await doc.embedFont(fonts.bold, { subset: true });
    const size = 9;
    const lead = size * 1.35;
    const left = mm(18);
    const width = mm(210 - 36);
    let page = doc.addPage([mm(210), mm(297)]);
    let y = mm(297 - 20);
    const heading = this.fit(bold, title, 12, width);
    page.drawText(heading, { x: left, y, size: 12, font: bold });
    y -= lead * 2;
    const lines = content.replace(/\r\n?/g, '\n').split('\n').slice(0, 5000);
    for (const raw of lines) {
      let rest = raw.replace(/\t/g, '    ');
      do {
        let cut = rest;
        while (cut.length > 1 && regular.widthOfTextAtSize(cut, size) > width) cut = cut.slice(0, -1);
        // Break at a space when there is one in the last stretch.
        const space = cut.length < rest.length ? cut.lastIndexOf(' ') : -1;
        if (space > cut.length * 0.5) cut = cut.slice(0, space);
        if (y < mm(20)) {
          page = doc.addPage([mm(210), mm(297)]);
          y = mm(297 - 20);
        }
        if (cut) page.drawText(cut, { x: left, y, size, font: regular });
        y -= lead;
        rest = rest.slice(cut.length).replace(/^ /, '');
      } while (rest.length);
    }
    doc.setTitle(title);
    doc.setProducer('Nexra B.V.');
    return Buffer.from(await doc.save());
  }

  /** A page that only says something: a document that could not be put in the bundle, and why. */
  async noticePage(title: string, lines: string[]): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const fonts = await this.loadFonts();
    const regular = await doc.embedFont(fonts.regular, { subset: true });
    const bold = await doc.embedFont(fonts.bold, { subset: true });
    const page = doc.addPage([mm(210), mm(297)]);
    page.drawText(this.fit(bold, title, 14, mm(174)), { x: mm(18), y: mm(297 - 30), size: 14, font: bold });
    lines.forEach((line, index) => page.drawText(this.fit(regular, line, 10, mm(174)), { x: mm(18), y: mm(297 - 42) - index * 15, size: 10, font: regular }));
    doc.setProducer('Nexra B.V.');
    return Buffer.from(await doc.save());
  }

  /** How wide a text is on the page, in millimetres — to cut an address into lines that fit. */
  async widthOf(text: string, sizePt: number, bold = false): Promise<number> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const fonts = await this.loadFonts();
    const font = await doc.embedFont(bold ? fonts.bold : fonts.regular, { subset: true });
    return font.widthOfTextAtSize(text, sizePt) / POINTS_PER_MM;
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async load(bytes: Buffer): Promise<PDFDocument> {
    try {
      return await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (error) {
      if (error instanceof EncryptedPDFError) throw new PdfError('pdf_encrypted');
      this.logger.debug(`A PDF could not be read: ${(error as Error).message}`);
      throw new PdfError('pdf_unreadable');
    }
  }

  private async loadFonts(): Promise<{ regular: Buffer; bold: Buffer }> {
    if (!this.fonts) this.fonts = { regular: await readFile(path.join(FONT_DIRECTORY, 'Roboto-Regular.ttf')), bold: await readFile(path.join(FONT_DIRECTORY, 'Roboto-Medium.ttf')) };
    return this.fonts;
  }
}
