import { Injectable, PayloadTooLargeException, UnprocessableEntityException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { AiService } from '../../lib/ai/ai.service.js';
import { AiError, type AiInputFile } from '../../lib/ai/ai.types.js';
import { DocumentReaderService, type ReadResult } from '../../lib/documents/document-reader.service.js';
import { FILE_TYPES, extensionOf } from '../files/files.constants.js';
import { FormsService } from '../forms/forms.service.js';
import { COMMON_INSTRUCTIONS, buildExtractionSchema, readAnswer, type KindSpec } from '../imports/document-kinds.js';
import { ImportLookupsService } from '../imports/import-lookups.service.js';
import { OfficialFormsService } from './official-forms.service.js';
import { placeholdersOf, readMapping } from './form-mapping.js';
import { readFields } from './form-fields.js';
import type { PrepareDto } from './dto/official-forms.dto.js';

const READABLE = new Set(['png', 'jpg', 'jpeg', 'webp', 'pdf', 'docx', 'txt']);
const MAX_PAGES = 20;
const TEXT_CHARACTERS = 20_000;

export interface SourceReading {
  /** The values the document holds, by source key (`person.last_name`): typed as the form field is (dates `YYYY-MM-DD`, choices by code). */
  values: Record<string, unknown>;
  /** How sure the AI is of each value, 0 – 1. */
  confidence: Record<string, number>;
  /** Values that did not fit their field. */
  problems: string[];
  /** The AI was not asked: nothing in the form can be read from a document. */
  nothingToRead: boolean;
}

/**
 * Filling a form in from a photo, a scan or a PDF: a picture of an ID card, a KvK extract, a letter. The AI is asked only for the details this form uses (the fields of
 * the client and the person that the mapping reads), and only what is really on the document. Its answer is never saved to a record: the person filling the form in sees
 * it as suggestions, next to what the records say, and decides. The file itself is read and forgotten.
 */
@Injectable()
export class FormAiService {
  constructor(
    private readonly ai: AiService,
    private readonly reader: DocumentReaderService,
    private readonly forms: OfficialFormsService,
    private readonly formDefinitions: FormsService,
    private readonly lookups: ImportLookupsService,
  ) {}

  /** The source keys of the client and the person that the mapping of an edition reads. */
  private keysOf(mapping: ReturnType<typeof readMapping>): { client: string[]; person: string[] } {
    const keys = new Set<string>();
    for (const entry of mapping) {
      if (entry.source?.type === 'field') keys.add(entry.source.key);
      if (entry.source?.type === 'compose') for (const key of placeholdersOf(entry.source.template)) keys.add(key);
    }
    const pick = (group: string) => [...keys].filter(key => key.startsWith(`${group}.`)).map(key => key.slice(group.length + 1));
    return { client: pick('client'), person: pick('person') };
  }

  async read(formId: string, file: Express.Multer.File | undefined, dto: Pick<PrepareDto, 'versionId'>, user: AuthenticatedUser): Promise<SourceReading> {
    if (!file) throw new UnprocessableEntityException({ code: 'file_missing', message: 'Choose a file to read.' });
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const extension = extensionOf(name);
    if (!READABLE.has(extension) || !FILE_TYPES[extension]?.matches(file.buffer.subarray(0, 4096))) throw new UnsupportedMediaTypeException({ code: 'file_type_not_allowed', message: 'This type of file cannot be read.', details: { allowed: [...READABLE] } });
    if (file.size > this.ai.maxFileBytes()) throw new PayloadTooLargeException({ code: 'file_too_large', message: 'The file is too large for the AI.', details: { maxMegabytes: Math.round(this.ai.maxFileBytes() / 1024 / 1024) } });

    const form = await this.forms.rowOrThrow(formId);
    const version = dto.versionId ? form.versions.find(entry => entry.id === dto.versionId) : OfficialFormsService.current(form);
    const mapping = version ? readMapping(version.mapping).filter(entry => readFields(version.fields).some(field => field.name === entry.pdfField)) : [];
    const wanted = this.keysOf(mapping);
    const [clientDoc, personDoc, context] = await Promise.all([this.formDefinitions.live('client'), this.formDefinitions.live('person'), this.lookups.context()]);
    const spec: KindSpec = {
      type: 'form_fill',
      feature: 'form_fill',
      sections: [
        { section: 'client', keys: wanted.client },
        { section: 'person', keys: wanted.person },
      ],
      task: [
        `The document is a source for filling in an official form of the Dutch tax authority ("${form.nameEn}").`,
        'It can be an identity document, a residence permit, an extract of the Chamber of Commerce (KvK), a letter, or any other paper about the company or the person.',
        'The "client" block is the company (for a sole trader: the business); the "person" block is a person — the owner, a director, a partner or an employee.',
        'Give only the details that are really on the document; use null for everything else.',
      ].join(' '),
      maxOutputTokens: 2400,
    };
    const built = buildExtractionSchema(spec, { client: clientDoc.doc, person: personDoc.doc }, user.matrix, context);
    if (!Object.keys((built.schema.properties as Record<string, unknown>) ?? {}).length) return { values: {}, confidence: {}, problems: [], nothingToRead: true };

    const content = await this.reader.read(file.buffer, extension);
    if (content.kind === 'pdf' && content.pages !== null && content.pages > MAX_PAGES) throw new UnprocessableEntityException({ code: 'file_too_large', message: 'The PDF has too many pages to read.' });
    const attachments = content.text ? [] : this.attachment(name, file.buffer, content, extension);
    try {
      const result = await this.ai.extract<unknown>({
        feature: 'form_fill',
        tier: 'main',
        instructions: `${COMMON_INSTRUCTIONS} ${spec.task}`,
        text: [`File name: ${name}`, content.text ? `Text found on the document:\n${content.text.slice(0, TEXT_CHARACTERS)}` : ''].filter(Boolean).join('\n'),
        files: attachments,
        schemaName: 'form_fill',
        schema: built.schema,
        maxOutputTokens: spec.maxOutputTokens,
        userId: user.id,
      });
      const answer = readAnswer(result.data, built, context);
      const values: Record<string, unknown> = {};
      const confidence: Record<string, number> = {};
      for (const [section, found] of Object.entries(answer.sections)) {
        for (const [key, value] of Object.entries(found)) {
          values[`${section}.${key}`] = value;
          confidence[`${section}.${key}`] = answer.confidence[section]?.[key] ?? 0;
        }
      }
      return { values, confidence, problems: Object.keys(answer.problems), nothingToRead: false };
    } catch (error) {
      if (error instanceof AiError) throw new UnprocessableEntityException({ code: error.code, message: 'The AI could not read this document.' });
      throw error;
    }
  }

  /** A photo or a scanned PDF goes to the AI as it is; a document with text went along as text. */
  private attachment(name: string, buffer: Buffer, content: ReadResult, extension: string): AiInputFile[] {
    if (content.kind === 'image') return [{ kind: 'image', mime: FILE_TYPES[extension]?.mime ?? 'image/jpeg', name, data: buffer, detail: 'high' }];
    if (content.kind === 'pdf') return [{ kind: 'pdf', mime: 'application/pdf', name, data: buffer, detail: 'high' }];
    return [];
  }
}
