import { Injectable, Logger } from '@nestjs/common';
import PizZip from 'pizzip';
import { extractText, getDocumentProxy } from 'unpdf';

/** What was found in a file before anything is asked of the AI. */
export interface ReadResult {
  kind: 'pdf' | 'image' | 'docx' | 'text' | 'spreadsheet' | 'other';
  /** The text in the file (a PDF's text layer, a Word document, a text file); empty for a photo or a scan. */
  text: string;
  pages: number | null;
  /** A photo, or a PDF without a text layer: only eyes can read it. */
  scanned: boolean;
}

/** What was found in a file for the content search of the Documents page. */
export interface SearchRead {
  /** `done`: there is text · `empty`: a scan or a photo (nothing to read without OCR) · `unsupported`: a kind of file that holds no readable text. */
  status: 'done' | 'empty' | 'unsupported';
  text: string;
  pages: number | null;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'eml']);
const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'ods']);
/** Files that are a ZIP of XML parts: the text is in these parts. */
const ZIP_TEXT: Record<string, RegExp> = {
  xlsx: /^xl\/sharedStrings\.xml$/,
  ods: /^content\.xml$/,
  odt: /^content\.xml$/,
  pptx: /^ppt\/slides\/slide\d+\.xml$/,
};
/** A PDF with fewer characters per page than this on its first pages has no usable text layer (a scan). */
const MIN_CHARACTERS_PER_PAGE = 40;
const MAX_TEXT_CHARACTERS = 200_000;
const PDF_TIMEOUT_MS = 30_000;
/** More pages than this are not read by the import (a book, a report): the file is only filed. */
export const MAX_PAGES = 60;
/** The content search reads further: the text layer of a long PDF costs a few seconds in the background. */
const MAX_SEARCH_PAGES = 400;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

/** The text of an XML part: tags gone, paragraphs and cells apart, the usual entities turned back. */
const xmlText = (xml: string): string =>
  xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/(?:w:p|text:p|a:p|si)>/g, '\n')
    .replace(/<(?:w:br|text:line-break)[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ENTITIES[entity] ?? entity)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Finds the text in a file, with code. Only what code cannot read (photos, scans) is left for the AI — or, for the content search, for nobody. */
@Injectable()
export class DocumentReaderService {
  private readonly logger = new Logger(DocumentReaderService.name);

  async read(bytes: Buffer, extension: string): Promise<ReadResult> {
    if (extension === 'pdf') return this.readPdf(bytes, MAX_PAGES);
    if (IMAGE_EXTENSIONS.has(extension)) return { kind: 'image', text: '', pages: 1, scanned: true };
    if (extension === 'docx') return this.readDocx(bytes);
    if (TEXT_EXTENSIONS.has(extension)) return { kind: 'text', text: this.decode(bytes).slice(0, MAX_TEXT_CHARACTERS), pages: null, scanned: false };
    if (SPREADSHEET_EXTENSIONS.has(extension)) return { kind: 'spreadsheet', text: '', pages: null, scanned: false };
    return { kind: 'other', text: '', pages: null, scanned: false };
  }

  /** The text of a document for the content search: everything the file holds, as far as code can read it. */
  async readForSearch(bytes: Buffer, extension: string): Promise<SearchRead> {
    if (extension === 'pdf') {
      const result = await this.readPdf(bytes, MAX_SEARCH_PAGES);
      return { status: result.text ? 'done' : 'empty', text: result.text, pages: result.pages };
    }
    if (IMAGE_EXTENSIONS.has(extension)) return { status: 'empty', text: '', pages: 1 };
    let text: string;
    if (extension === 'docx') text = this.readDocx(bytes).text;
    else if (extension in ZIP_TEXT) text = this.readZip(bytes, ZIP_TEXT[extension]!);
    else if (extension === 'rtf') text = this.readRtf(bytes);
    else if (TEXT_EXTENSIONS.has(extension)) text = this.decode(bytes);
    else return { status: 'unsupported', text: '', pages: null };
    const cut = text.slice(0, MAX_TEXT_CHARACTERS).trim();
    return { status: cut ? 'done' : 'empty', text: cut, pages: null };
  }

  private async readPdf(bytes: Buffer, maxPages: number): Promise<ReadResult> {
    try {
      const document = await getDocumentProxy(new Uint8Array(bytes));
      const pages = document.numPages;
      if (pages > maxPages) return { kind: 'pdf', text: '', pages, scanned: true };
      const result = await Promise.race([
        extractText(document, { mergePages: true }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), PDF_TIMEOUT_MS).unref()),
      ]);
      const text = result.text.replace(/[ \t]+\n/g, '\n').trim().slice(0, MAX_TEXT_CHARACTERS);
      const scanned = text.replace(/\s/g, '').length < MIN_CHARACTERS_PER_PAGE * Math.min(pages, 3);
      return { kind: 'pdf', text: scanned ? '' : text, pages, scanned };
    } catch (error) {
      this.logger.debug(`A PDF could not be read for its text: ${(error as Error).message}`);
      return { kind: 'pdf', text: '', pages: null, scanned: true };
    }
  }

  private readDocx(bytes: Buffer): ReadResult {
    try {
      const xml = new PizZip(bytes).file('word/document.xml')?.asText() ?? '';
      return { kind: 'docx', text: xmlText(xml).slice(0, MAX_TEXT_CHARACTERS), pages: null, scanned: false };
    } catch {
      return { kind: 'docx', text: '', pages: null, scanned: false };
    }
  }

  /** The text of the XML parts of a ZIP-based file (a spreadsheet's strings, an OpenDocument file's content, a presentation's slides). */
  private readZip(bytes: Buffer, parts: RegExp): string {
    try {
      const zip = new PizZip(bytes);
      return zip
        .file(parts)
        .map(part => xmlText(part.asText()))
        .join('\n');
    } catch {
      return '';
    }
  }

  /** Rich Text Format: the control words and groups taken out, what is left is the text. */
  private readRtf(bytes: Buffer): string {
    return this.decode(bytes)
      .replace(/\\par[d]?/g, '\n')
      .replace(/\\'([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\[a-z]+-?\d* ?/gi, '')
      .replace(/[{}]/g, '')
      .trim();
  }

  /** UTF-8 when the bytes are valid UTF-8, otherwise Windows-1252 (what Dutch Office programs save). */
  private decode(bytes: Buffer): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
}
