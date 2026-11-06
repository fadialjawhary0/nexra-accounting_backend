import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { OfficialForm, OfficialFormVersion, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { PdfService } from '../../lib/pdf/pdf.service.js';
import { PdfError, type PdfFieldInfo, type PdfFormInfo } from '../../lib/pdf/pdf.types.js';
import { FilesService } from '../files/files.service.js';
import type { CreateVersionDto, SaveMappingDto, SetupDto, UploadFormDto } from './dto/official-forms.dto.js';
import { isFillable, readFields, sanitizeBoxes } from './form-fields.js';
import { readMapping, sanitizeMapping } from './form-mapping.js';
import { readSetup, setupView, withContext, type FormSetup } from './form-setup.js';
import { FormSetupService } from './form-setup.service.js';
import { FormSourcesService } from './form-sources.service.js';
import { OFFICIAL_FORM_ENTITY } from './official-forms.constants.js';
import { OfficialFormsService } from './official-forms.service.js';

/** A PDF the program cannot work with, as the 422 the screen shows (the code is also the translation key). */
export function pdfProblem(error: unknown): never {
  if (error instanceof PdfError) throw new UnprocessableEntityException({ code: error.code, message: 'This PDF cannot be used.' });
  throw error;
}

/** `Opgaaf_rekeningnummer-2026.pdf` → `Opgaaf rekeningnummer 2026`: the name a form gets from its file until the AI (or a person) gives it a better one. */
export function nameFromFile(fileName: string): string {
  const name = fileName
    .replace(/\.pdf$/i, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (name.charAt(0).toUpperCase() + name.slice(1)).slice(0, 120) || 'Formulier';
}

interface ReadPdf {
  fileId: string;
  fileName: string;
  info: PdfFormInfo;
  fields: PdfFieldInfo[];
}

/**
 * The editions of a form: a new blank PDF is read for its fields (and where each one is, and the words printed next to it), what was mapped for the edition before
 * it is kept for every field the new one still has, and the AI is asked to set up the rest in the background. A PDF without fields can be used too: its answers are
 * written onto the page, in boxes the AI places (or a person draws). The mapping and the boxes of an edition are saved here too.
 */
@Injectable()
export class OfficialFormVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly pdf: PdfService,
    private readonly sources: FormSourcesService,
    private readonly forms: OfficialFormsService,
    private readonly setup: FormSetupService,
    private readonly audit: AuditService,
  ) {}

  /** The uploaded PDF, read: its fields with where they are and the words next to them. A protected or dynamic (Adobe-only) PDF is refused with what to do about it. */
  private async readPdf(fileId: string): Promise<ReadPdf> {
    const file = await this.files.uploaded(fileId, ['form_blank']);
    if (await this.prisma.officialFormVersion.findUnique({ where: { fileId: file.id }, select: { id: true } })) {
      throw new ConflictException({ code: 'form_file_used', message: 'This file is an edition of a form already.' });
    }
    const { buffer } = await this.files.bytes(file.id);
    const info = await this.pdf.inspect(buffer).catch(pdfProblem);
    const fillable = info.fields.some(isFillable);
    // A dynamic form of Adobe (XFA) without classic fields only shows its questions in Adobe Reader: there is nothing to fill in or to write on.
    if (!fillable && info.hasXfa) throw new UnprocessableEntityException({ code: 'pdf_dynamic_form', message: 'This PDF only works in Adobe Reader.' });
    const fields = fillable ? withContext(info.fields, await this.pdf.layout(buffer, 20)) : info.fields;
    return { fileId: file.id, fileName: file.name, info, fields };
  }

  /** A new edition from an uploaded PDF; the AI starts setting it up. */
  async create(formId: string, dto: CreateVersionDto, user: AuthenticatedUser) {
    const form = await this.forms.rowOrThrow(formId);
    return this.addEdition(form, await this.readPdf(dto.fileId), dto, user, { details: false });
  }

  /** A new form made from its PDF in one go: named after the file until the AI reads its real name, code and subject from the PDF. */
  async createForm(dto: UploadFormDto, user: AuthenticatedUser, locale: AppLocale) {
    const read = await this.readPdf(dto.fileId);
    const name = dto.name?.trim() || nameFromFile(read.fileName);
    const created = await this.forms.create({ nameNl: name, nameEn: name }, user, locale);
    const form = await this.forms.rowOrThrow(created.id);
    await this.addEdition(form, read, { fileId: dto.fileId }, user, { details: !dto.name?.trim() });
    return this.forms.one(created.id, locale);
  }

  private async addEdition(form: OfficialForm & { versions: OfficialFormVersion[] }, read: ReadPdf, dto: CreateVersionDto, user: AuthenticatedUser, options: { details: boolean }) {
    const previous = OfficialFormsService.current(form);
    let kept = 0;
    let dropped = 0;
    let mapping: ReturnType<typeof sanitizeMapping>['mapping'] = [];
    let fields = read.fields;
    if (previous && dto.copyMapping !== false) {
      // What was mapped stays for every field the new edition still has under the same name and of the same kind; boxes placed on a PDF without fields come along
      // when the new PDF has no fields either (a reprint of the same form).
      const oldFields = readFields(previous.fields);
      const oldKinds = new Map(oldFields.filter(field => !field.placed).map(field => [field.name, field.kind]));
      if (!read.fields.some(isFillable)) fields = [...read.fields, ...oldFields.filter(field => field.placed && field.page < read.info.pageCount)];
      const before = readMapping(previous.mapping);
      const carried = before.filter(entry => fields.some(field => field.name === entry.pdfField && (field.placed || field.kind === oldKinds.get(entry.pdfField))));
      const known = await this.sources.knownKeys();
      mapping = sanitizeMapping(carried, fields, key => known.has(key)).mapping;
      kept = mapping.length;
      dropped = before.length - kept;
    }
    const number = (previous?.version ?? 0) + 1;
    const setup: Partial<FormSetup> = { status: 'none', pages: read.info.pages };
    const version = await this.prisma.officialFormVersion.create({
      data: {
        formId: form.id,
        version: number,
        fileId: read.fileId,
        fileName: read.fileName,
        pageCount: read.info.pageCount,
        fields: fields as unknown as Prisma.InputJsonArray,
        mapping: mapping as unknown as Prisma.InputJsonArray,
        setup: setup as Prisma.InputJsonObject,
        note: (dto.note ?? '').trim(),
        createdById: user.id,
      },
    });
    await this.files.link([read.fileId], 'official_form', form.id);
    await this.audit.log({ action: 'updated', entityType: OFFICIAL_FORM_ENTITY, entityId: form.id, entityLabel: form.nameNl, after: { edition: number, file: read.fileName, mapped: kept } });
    // The AI sets up what is not mapped yet (a new form: everything).
    const started = await this.setup.start(version, form, { details: options.details });
    return { ...OfficialFormsService.versionSummary({ ...version, setup: started as unknown as Prisma.JsonValue }), kept, dropped, hasXfa: read.info.hasXfa };
  }

  private async versionOrThrow(formId: string, versionId: string) {
    const version = await this.prisma.officialFormVersion.findFirst({ where: { id: versionId, formId } });
    if (!version) throw new NotFoundException({ code: 'not_found', message: 'Edition not found' });
    return version;
  }

  /** An edition uploaded before the program kept where its fields are: they are read again once (positions and the words next to them), so the page view can show them. */
  private async withPositions(version: OfficialFormVersion): Promise<OfficialFormVersion> {
    const setup = readSetup(version.setup);
    // The page sizes are kept together with the positions: an edition that has them was read this way already.
    if (setup.pages.length) return version;
    const fields = readFields(version.fields);
    try {
      const { buffer } = await this.files.bytes(version.fileId);
      const info = await this.pdf.inspect(buffer);
      const fresh = withContext(info.fields, await this.pdf.layout(buffer, 20));
      const merged = [...fresh, ...fields.filter(field => field.placed)];
      return await this.prisma.officialFormVersion.update({
        where: { id: version.id },
        data: { fields: merged as unknown as Prisma.InputJsonArray, setup: { ...setup, pages: info.pages } as unknown as Prisma.InputJsonObject },
      });
    } catch {
      return version;
    }
  }

  /** One edition for the mapping editor: every field of the PDF (and every placed box), what is mapped to it, and what the AI did. */
  async one(formId: string, versionId: string) {
    const version = await this.withPositions(await this.versionOrThrow(formId, versionId));
    const setup = readSetup(version.setup);
    return {
      ...OfficialFormsService.versionSummary(version),
      fieldList: readFields(version.fields).map(field => ({ ...field, fillable: isFillable(field) })),
      mapping: readMapping(version.mapping),
      pages: setup.pages,
      suggested: setup.suggested,
    };
  }

  /** Saves the mapping of an edition (a field that is not mentioned is not mapped) and, when sent, the boxes placed on its pages. A person saved it: the AI's links count as checked. */
  async saveMapping(formId: string, versionId: string, dto: SaveMappingDto) {
    const form = await this.forms.rowOrThrow(formId);
    const version = await this.versionOrThrow(formId, versionId);
    const setup = readSetup(version.setup);
    let fields = readFields(version.fields);
    if (dto.boxes) {
      const { boxes, problems } = sanitizeBoxes(dto.boxes, version.pageCount, setup.pages);
      if (Object.keys(problems).length) throw validationFailed(problems);
      fields = [...fields.filter(field => !field.placed), ...boxes];
    }
    const known = await this.sources.knownKeys();
    const { mapping, problems } = sanitizeMapping(dto.mapping, fields, key => known.has(key));
    if (Object.keys(problems).length) throw validationFailed(problems);
    const before = readMapping(version.mapping).filter(entry => entry.source !== null).length;
    await this.prisma.officialFormVersion.update({
      where: { id: versionId },
      data: {
        mapping: mapping as unknown as Prisma.InputJsonArray,
        ...(dto.boxes && { fields: fields as unknown as Prisma.InputJsonArray }),
        setup: { ...setup, suggested: [] } as unknown as Prisma.InputJsonObject,
      },
    });
    const after = mapping.filter(entry => entry.source !== null).length;
    await this.audit.log({
      action: 'updated',
      entityType: OFFICIAL_FORM_ENTITY,
      entityId: formId,
      entityLabel: form.nameNl,
      before: { mapped: before },
      after: { mapped: after, edition: version.version, ...(dto.boxes && { boxes: fields.filter(field => field.placed).length }) },
    });
    return this.one(formId, versionId);
  }

  /** Lets the AI set the PDF up again: the fields nobody linked yet, or — for a PDF without fields, with `replace` — all of its boxes. */
  async rerun(formId: string, versionId: string, dto: SetupDto) {
    const form = await this.forms.rowOrThrow(formId);
    const version = await this.versionOrThrow(formId, versionId);
    const current = readSetup(version.setup);
    if (current.status === 'waiting' || current.status === 'running') return this.one(formId, versionId);
    await this.setup.start(version, form, { details: false, replace: dto.replace === true });
    return this.one(formId, versionId);
  }

  /** The blank PDF of an edition: bytes and the name to show. */
  async blank(formId: string, versionId: string): Promise<{ buffer: Buffer; name: string }> {
    const version = await this.versionOrThrow(formId, versionId);
    const { buffer } = await this.files.bytes(version.fileId);
    return { buffer, name: version.fileName };
  }

  /** What the screens show of the AI set-up of an edition. */
  static setupOf(version: OfficialFormVersion) {
    return setupView(readSetup(version.setup));
  }
}
