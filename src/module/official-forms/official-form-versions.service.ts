import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { validationFailed } from '../../common/validation/failure.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { PdfService } from '../../lib/pdf/pdf.service.js';
import { PdfError } from '../../lib/pdf/pdf.types.js';
import { FilesService } from '../files/files.service.js';
import type { CreateVersionDto, SaveMappingDto } from './dto/official-forms.dto.js';
import { isFillable, readFields } from './form-fields.js';
import { readMapping, sanitizeMapping } from './form-mapping.js';
import { FormSourcesService } from './form-sources.service.js';
import { OFFICIAL_FORM_ENTITY } from './official-forms.constants.js';
import { OfficialFormsService } from './official-forms.service.js';

/** A PDF the program cannot work with, as the 422 the screen shows (the code is also the translation key). */
export function pdfProblem(error: unknown): never {
  if (error instanceof PdfError) throw new UnprocessableEntityException({ code: error.code, message: 'This PDF cannot be used.' });
  throw error;
}

/**
 * The editions of a form: a new blank PDF is read for its fields, and what was mapped for the edition before it is kept for every field the new one still has —
 * so a new edition of the same form is a matter of checking what changed, not of starting over. The mapping of an edition is saved here too.
 */
@Injectable()
export class OfficialFormVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly pdf: PdfService,
    private readonly sources: FormSourcesService,
    private readonly forms: OfficialFormsService,
    private readonly audit: AuditService,
  ) {}

  /** A new edition from an uploaded PDF. */
  async create(formId: string, dto: CreateVersionDto, user: AuthenticatedUser) {
    const form = await this.forms.rowOrThrow(formId);
    const file = await this.files.uploaded(dto.fileId, ['form_blank']);
    if (await this.prisma.officialFormVersion.findUnique({ where: { fileId: file.id }, select: { id: true } })) {
      throw new ConflictException({ code: 'form_file_used', message: 'This file is an edition of a form already.' });
    }
    const { buffer } = await this.files.bytes(file.id);
    const info = await this.pdf.inspect(buffer).catch(pdfProblem);
    if (!info.fields.some(isFillable)) throw new UnprocessableEntityException({ code: 'pdf_no_fields', message: 'This PDF has no fields to fill in.' });

    const previous = OfficialFormsService.current(form);
    let kept = 0;
    let dropped = 0;
    let mapping: ReturnType<typeof sanitizeMapping>['mapping'] = [];
    if (previous && dto.copyMapping !== false) {
      // What was mapped stays for every field the new edition still has under the same name and of the same kind.
      const oldKinds = new Map(readFields(previous.fields).map(field => [field.name, field.kind]));
      const before = readMapping(previous.mapping);
      const carried = before.filter(entry => info.fields.some(field => field.name === entry.pdfField && field.kind === oldKinds.get(entry.pdfField)));
      const known = await this.sources.knownKeys();
      mapping = sanitizeMapping(carried, info.fields, key => known.has(key)).mapping;
      kept = mapping.length;
      dropped = before.length - kept;
    }
    const number = (previous?.version ?? 0) + 1;
    const version = await this.prisma.officialFormVersion.create({
      data: {
        formId,
        version: number,
        fileId: file.id,
        fileName: file.name,
        pageCount: info.pageCount,
        fields: info.fields as unknown as Prisma.InputJsonArray,
        mapping: mapping as unknown as Prisma.InputJsonArray,
        note: (dto.note ?? '').trim(),
        createdById: user.id,
      },
    });
    await this.files.link([file.id], 'official_form', formId);
    await this.audit.log({ action: 'updated', entityType: OFFICIAL_FORM_ENTITY, entityId: formId, entityLabel: form.nameNl, after: { edition: number, file: file.name, mapped: kept } });
    return { ...OfficialFormsService.versionSummary(version), kept, dropped, hasXfa: info.hasXfa };
  }

  private async versionOrThrow(formId: string, versionId: string) {
    const version = await this.prisma.officialFormVersion.findFirst({ where: { id: versionId, formId } });
    if (!version) throw new NotFoundException({ code: 'not_found', message: 'Edition not found' });
    return version;
  }

  /** One edition for the mapping editor: every field of the PDF and what is mapped to it. */
  async one(formId: string, versionId: string) {
    const version = await this.versionOrThrow(formId, versionId);
    return {
      ...OfficialFormsService.versionSummary(version),
      fieldList: readFields(version.fields).map(field => ({ ...field, fillable: isFillable(field) })),
      mapping: readMapping(version.mapping),
    };
  }

  /** Saves the mapping of an edition (a field that is not mentioned is not mapped). */
  async saveMapping(formId: string, versionId: string, dto: SaveMappingDto) {
    const form = await this.forms.rowOrThrow(formId);
    const version = await this.versionOrThrow(formId, versionId);
    const known = await this.sources.knownKeys();
    const { mapping, problems } = sanitizeMapping(dto.mapping, readFields(version.fields), key => known.has(key));
    if (Object.keys(problems).length) throw validationFailed(problems);
    const before = readMapping(version.mapping).filter(entry => entry.source !== null).length;
    await this.prisma.officialFormVersion.update({ where: { id: versionId }, data: { mapping: mapping as unknown as Prisma.InputJsonArray } });
    const after = mapping.filter(entry => entry.source !== null).length;
    await this.audit.log({ action: 'updated', entityType: OFFICIAL_FORM_ENTITY, entityId: formId, entityLabel: form.nameNl, before: { mapped: before }, after: { mapped: after, edition: version.version } });
    return this.one(formId, versionId);
  }

  /** The blank PDF of an edition: bytes and the name to show. */
  async blank(formId: string, versionId: string): Promise<{ buffer: Buffer; name: string }> {
    const version = await this.versionOrThrow(formId, versionId);
    const { buffer } = await this.files.bytes(version.fileId);
    return { buffer, name: version.fileName };
  }
}
