import { Injectable, Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { AppConfigService } from '../config/app-config.service.js';
import { lookup, openTemplate, problemsOf, scanTemplate, splitTag, type TemplateTag } from './docx-template.js';
import { SerialQueue } from './serial-queue.js';

export type { TemplateProblem, TemplateTag } from './docx-template.js';

const run = promisify(execFile);
const CONVERSION_TIMEOUT_MS = 90_000;

export interface RenderResult {
  buffer: Buffer;
  /** Fields in the template that the data does not have at all (a typo, a removed form field): left as `{tag}` in the document. */
  unknown: string[];
  /** Fields the data has but that are empty. */
  empty: string[];
}

/**
 * Word templates (`.docx`) with merge fields, and Word → PDF. A template is an ordinary Word file in which the person typed fields such as
 * `{employee.first_name}`; the data of a record is poured into it with docxtemplater, and LibreOffice (a free program, run without a window)
 * makes the PDF. Conversions go through a queue of one. Feature modules only talk to this service.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly queue = new SerialQueue();
  private office: Promise<string | null> | undefined;

  constructor(private readonly config: AppConfigService) {}

  /** The merge fields a Word file uses (in order of appearance, with repeats), or a 422 saying what is wrong with it. */
  inspect(template: Buffer): TemplateTag[] {
    return scanTemplate(template);
  }

  /** Fills the template with `data` (nested: `{ employee: { first_name: 'Jan' } }`). Fields that are missing from the data stay visible as `{tag}`. */
  render(template: Buffer, data: Record<string, unknown>): RenderResult {
    const tags = scanTemplate(template);
    const unknown = new Set<string>();
    const document = openTemplate(template, {
      parser: (tag: string) => {
        const steps = splitTag(tag);
        return {
          get: (scope: unknown, context: { scopeList?: unknown[]; num?: number }) => {
            if (tag.trim() === '.') return scope;
            // The innermost block first, then the blocks around it, then the whole record.
            const list = context.scopeList ?? [scope];
            for (let index = Math.min(context.num ?? list.length - 1, list.length - 1); index >= 0; index -= 1) {
              const found = lookup(list[index], steps);
              if (found !== undefined) return found;
            }
            return undefined;
          },
        };
      },
      nullGetter: (part: { value?: unknown; module?: string }) => {
        const tag = String(part.value ?? '').trim();
        if (part.module) return '';
        if (tag) unknown.add(tag);
        return tag ? `{${tag}}` : '';
      },
    });
    try {
      document.render(data);
    } catch (error) {
      throw new UnprocessableEntityException({ code: 'template_invalid', message: 'The template could not be filled in.', details: { problems: problemsOf(error) } });
    }

    const empty = new Set<string>();
    for (const entry of tags) {
      if (entry.kind !== 'value' || entry.depth > 0) continue;
      const value = lookup(data, splitTag(entry.tag));
      if (value === '' || value === null) empty.add(entry.tag);
    }
    return { buffer: document.toBuffer() as Buffer, unknown: [...unknown], empty: [...empty] };
  }

  /* ── Word → PDF ───────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Whether LibreOffice is installed (and found). Without it Word files are still made, just not their PDF. */
  async pdfAvailable(): Promise<boolean> {
    return (await this.findOffice()) !== null;
  }

  /** Converts a Word file to PDF with LibreOffice. One conversion at a time. */
  async toPdf(docx: Buffer): Promise<Buffer> {
    const office = await this.findOffice();
    if (!office) {
      throw new ServiceUnavailableException({ code: 'pdf_unavailable', message: 'LibreOffice is not installed on the server, so no PDF can be made.' });
    }
    try {
      return await this.queue.run(() => this.convert(office, docx, 'docx', 'pdf:writer_pdf_Export', 'pdf'));
    } catch (error) {
      this.logger.error(`PDF conversion failed: ${(error as Error).message.split('\n')[0]}`);
      throw new ServiceUnavailableException({ code: 'pdf_failed', message: 'The PDF could not be made.' });
    }
  }

  /** Converts any Word, Excel, PowerPoint or OpenDocument file to PDF (for looking at it); the type is the file's extension. */
  async anyToPdf(bytes: Buffer, extension: string): Promise<Buffer> {
    const office = await this.findOffice();
    if (!office) {
      throw new ServiceUnavailableException({ code: 'pdf_unavailable', message: 'LibreOffice is not installed on the server, so no PDF can be made.' });
    }
    try {
      return await this.queue.run(() => this.convert(office, bytes, extension, 'pdf', 'pdf'));
    } catch (error) {
      this.logger.error(`PDF conversion of a .${extension} file failed: ${(error as Error).message.split('\n')[0]}`);
      throw new ServiceUnavailableException({ code: 'pdf_failed', message: 'The PDF could not be made.' });
    }
  }

  /** What an old Excel / Word file becomes when LibreOffice converts it (so the import can read it). */
  static readonly MODERN_FORMAT: Readonly<Record<string, 'xlsx' | 'docx'>> = { xls: 'xlsx', ods: 'xlsx', doc: 'docx', odt: 'docx', rtf: 'docx' };

  /** Converts an old Excel or Word file (`xls`, `ods`, `doc`, `odt`, `rtf`) to `xlsx` / `docx`. `null` when LibreOffice is not installed or cannot read the file. */
  async toModernFormat(bytes: Buffer, extension: string): Promise<Buffer | null> {
    const target = DocumentsService.MODERN_FORMAT[extension];
    const office = target ? await this.findOffice() : null;
    if (!target || !office) return null;
    try {
      return await this.queue.run(() => this.convert(office, bytes, extension, target === 'xlsx' ? 'xlsx:Calc MS Excel 2007 XML' : 'docx:MS Word 2007 XML', target));
    } catch (error) {
      this.logger.warn(`Converting a .${extension} file failed: ${(error as Error).message.split('\n')[0]}`);
      return null;
    }
  }

  private async convert(office: string, bytes: Buffer, inputExtension: string, filter: string, outputExtension: string): Promise<Buffer> {
    // A fixed profile folder: LibreOffice starts much faster once it has set itself up, and the queue guarantees nobody else uses it.
    const profile = path.join(tmpdir(), 'nexra-libreoffice-profile');
    await mkdir(profile, { recursive: true });
    const folder = await mkdtemp(path.join(tmpdir(), 'nexra-pdf-'));
    try {
      const input = path.join(folder, `document.${inputExtension}`);
      await writeFile(input, bytes);
      const attempt = () =>
        run(
          office,
          ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo', `-env:UserInstallation=${pathToFileURL(profile).href}`, '--convert-to', filter, '--outdir', folder, input],
          { timeout: CONVERSION_TIMEOUT_MS, windowsHide: true },
        );
      try {
        await attempt();
      } catch (error) {
        // A profile that was left half-written by an earlier crash: start again with a clean one.
        this.logger.warn(`LibreOffice failed once (${(error as Error).message.split('\n')[0]}); retrying with a clean profile.`);
        await rm(profile, { recursive: true, force: true });
        await mkdir(profile, { recursive: true });
        await attempt();
      }
      return await readFile(path.join(folder, `document.${outputExtension}`));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /** `LIBREOFFICE_PATH`, or the usual places. `null` when LibreOffice cannot be found. Looked up once. */
  private findOffice(): Promise<string | null> {
    this.office ??= (async () => {
      const candidates = [
        this.config.libreOfficePath,
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        '/usr/bin/soffice',
        '/usr/bin/libreoffice',
        '/usr/local/bin/soffice',
        '/opt/libreoffice/program/soffice',
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      ].filter((entry): entry is string => Boolean(entry));
      for (const candidate of candidates) {
        try {
          await access(candidate);
          this.logger.log(`LibreOffice found: ${candidate}`);
          return candidate;
        } catch {
          // try the next one
        }
      }
      // Last try: a `soffice` on the PATH.
      try {
        await run('soffice', ['--version'], { timeout: 20_000, windowsHide: true });
        return 'soffice';
      } catch {
        this.logger.warn('LibreOffice was not found — Word files are made, PDF files are not. Set LIBREOFFICE_PATH in .env.');
        return null;
      }
    })();
    return this.office;
  }
}
