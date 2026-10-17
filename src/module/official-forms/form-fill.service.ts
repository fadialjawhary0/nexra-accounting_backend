import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { formatDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { OfficialForm, OfficialFormVersion, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { PdfService } from '../../lib/pdf/pdf.service.js';
import type { PdfFieldInfo, PdfFieldKind, PdfFieldValue } from '../../lib/pdf/pdf.types.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { addressLines } from '../address-book/address-book.service.js';
import { nameFromPattern } from '../document-settings/document-naming.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { FilesService } from '../files/files.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import type { DocLocale } from '../templates/merge-format.js';
import type { FillValuesDto, PrepareDto, SubmitDto, SubjectDto } from './dto/official-forms.dto.js';
import { isFillable, readFields, shortName } from './form-fields.js';
import { placeholdersOf, readMapping, sanitizeMapping, type FieldMapping, type SourceRef } from './form-mapping.js';
import { FormSourcesService, type SubjectContext } from './form-sources.service.js';
import { FormSubmissionsService } from './form-submissions.service.js';
import { composeText, formatValue, matchOption, passes, pickChoice, type Resolved } from './form-values.js';
import { pdfProblem } from './official-form-versions.service.js';
import { PENDING_STATUSES, SUBMISSION_ENTITY } from './official-forms.constants.js';
import { OfficialFormsService } from './official-forms.service.js';

/** What a field of the PDF is filled with, or may be: text, ticked or not, an option, several options. */
export type FieldValue = string | boolean | string[];

/** Why a field has the value it has (shown next to it so a person can judge). */
export type FieldState = 'filled' | 'empty' | 'ask' | 'restricted';

export interface PreparedField {
  pdfField: string;
  label: string;
  section: string;
  page: number;
  kind: PdfFieldKind;
  options: string[];
  value: FieldValue;
  state: FieldState;
  required: boolean;
  hint: string;
  maxLength: number | null;
  multiline: boolean;
  source: { type: SourceRef['type']; key: string | null };
  /** A sensitive value (BSN …) is, or would be, in this field: the filled form is then personal data. */
  restricted: boolean;
  /** What a photo or scan said, when that is different from the value. */
  suggestion?: FieldValue;
}

export interface PreparedWarning {
  code: 'client_stopped' | 'no_people' | 'pending_exists' | 'nothing_mapped' | 'sample_form' | 'form_inactive';
  params?: Record<string, unknown>;
}

const isEmptyValue = (value: FieldValue): boolean => (typeof value === 'boolean' ? !value : Array.isArray(value) ? value.length === 0 : !value.trim());

/**
 * Filling a form in: the values of a client (and a person, a worker, a period) are put into the fields of the PDF through the mapping; a person checks them and
 * fills the gaps; the PDF is shown, and when it is right it is filed with the client's documents and written in the log of sent forms. The mapping decides which
 * value goes where; nothing here knows what a particular form asks.
 */
@Injectable()
export class FormFillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pdf: PdfService,
    private readonly files: FilesService,
    private readonly types: DocumentTypesService,
    private readonly settings: SettingsService,
    private readonly sources: FormSourcesService,
    private readonly forms: OfficialFormsService,
    private readonly submissions: FormSubmissionsService,
  ) {}

  private documentLocale(): DocLocale {
    return this.settings.get<string>('locale.documentLocale') === 'en' ? 'en' : 'nl';
  }

  /* ── Choosing the edition and the mapping ─────────────────────────────────────────────────────────────────────── */

  private async editionOf(form: OfficialForm & { versions: OfficialFormVersion[] }, versionId?: string): Promise<OfficialFormVersion> {
    const version = versionId ? form.versions.find(entry => entry.id === versionId) : OfficialFormsService.current(form);
    if (!version) throw new NotFoundException({ code: 'not_found', message: 'This form has no PDF yet.' });
    return version;
  }

  /** The mapping to work with: the saved one, or — for somebody who edits the library — one that is being tried. */
  private async mappingOf(version: OfficialFormVersion, tried: unknown[] | undefined, user: AuthenticatedUser): Promise<{ mapping: FieldMapping[]; fields: PdfFieldInfo[] }> {
    const fields = readFields(version.fields);
    if (!tried) return { mapping: readMapping(version.mapping), fields };
    if (!matrixAllows(user.matrix, 'official_forms.edit')) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
    const known = await this.sources.knownKeys();
    const { mapping, problems } = sanitizeMapping(tried, fields, key => known.has(key));
    if (Object.keys(problems).length) throw validationFailed(problems);
    return { mapping, fields };
  }

  /** The period a form is about: what was asked for, else (for a yearly form) last year. */
  private periodOf(form: OfficialForm, dto: Pick<SubjectDto, 'periodStart' | 'periodEnd'>): { start: string; end: string } | null {
    if (form.periodKind === 'none') return null;
    if (dto.periodStart && dto.periodEnd) {
      if (dto.periodEnd < dto.periodStart) throw validationFailed({ periodEnd: 'validation.afterStart' });
      return { start: dto.periodStart, end: dto.periodEnd };
    }
    if (form.periodKind === 'year') {
      const year = Number(todayInAmsterdam().slice(0, 4)) - 1;
      return { start: `${year}-01-01`, end: `${year}-12-31` };
    }
    return null;
  }

  private async contextFor(form: OfficialForm, dto: SubjectDto, user: AuthenticatedUser) {
    if (form.subject === 'worker' && !dto.employeeId) throw validationFailed({ employeeId: 'validation.required' });
    const period = this.periodOf(form, dto);
    const context = await this.sources.context({ clientId: dto.clientId, personId: dto.personId, employeeId: dto.employeeId, period }, user, form.subject, this.documentLocale());
    return { context, period };
  }

  /* ── The values of every field ────────────────────────────────────────────────────────────────────────────────── */

  private resolveSource(source: SourceRef, context: SubjectContext): { resolved: Resolved | null; restricted: boolean; hidden: boolean } {
    switch (source.type) {
      case 'field': {
        const resolved = this.sources.resolve(context, source.key);
        return { resolved, restricted: resolved.restricted, hidden: resolved.hidden };
      }
      case 'compose': {
        const parts = placeholdersOf(source.template).map(key => this.sources.resolve(context, key));
        const hidden = parts.some(part => part.hidden);
        const text = hidden ? '' : composeText(source.template, key => this.sources.resolve(context, key).text);
        return { resolved: { raw: text || null, text, type: 'text', restricted: parts.some(part => part.restricted), hidden }, restricted: parts.some(part => part.restricted), hidden };
      }
      case 'fixed':
        return { resolved: { raw: source.value, text: source.value, type: 'text', restricted: false, hidden: false }, restricted: false, hidden: false };
      default:
        return { resolved: null, restricted: false, hidden: false };
    }
  }

  private valueOf(entry: FieldMapping, field: PdfFieldInfo, context: SubjectContext): { value: FieldValue; state: FieldState; restricted: boolean } {
    const source = entry.source!;
    const { resolved, restricted, hidden } = this.resolveSource(source, context);
    const empty: FieldValue = field.kind === 'checkbox' ? false : field.kind === 'list' ? [] : '';
    if (source.type === 'ask') return { value: empty, state: 'ask', restricted: false };
    if (hidden || !resolved) return { value: empty, state: 'restricted', restricted };

    let value: FieldValue;
    switch (field.kind) {
      case 'checkbox':
        value = passes(resolved, entry.test ?? { op: 'truthy' });
        return { value, state: 'filled', restricted };
      case 'radio':
      case 'dropdown':
      case 'list': {
        const option = entry.choices.length ? pickChoice(resolved, entry.choices, entry.fallback) : matchOption(resolved.text, field.options) || entry.fallback;
        value = field.kind === 'list' ? (option ? [option] : []) : option;
        break;
      }
      default:
        value = formatValue(resolved, entry.format, context.locale);
    }
    return { value, state: isEmptyValue(value) ? 'empty' : 'filled', restricted };
  }

  private fieldsOf(mapping: FieldMapping[], pdfFields: PdfFieldInfo[], context: SubjectContext, suggestions?: SubjectContext): PreparedField[] {
    const byName = new Map(mapping.map(entry => [entry.pdfField, entry]));
    const fields: PreparedField[] = [];
    for (const field of pdfFields) {
      const entry = byName.get(field.name);
      if (!entry?.source || !isFillable(field)) continue;
      const own = this.valueOf(entry, field, context);
      const proposed = suggestions ? this.valueOf(entry, field, suggestions) : null;
      const differs = proposed !== null && proposed.state !== 'ask' && !isEmptyValue(proposed.value) && JSON.stringify(proposed.value) !== JSON.stringify(own.value);
      fields.push({
        pdfField: field.name,
        label: entry.label || field.tooltip || shortName(field.name),
        section: entry.section,
        page: field.page,
        kind: field.kind,
        options: field.options,
        value: own.value,
        state: own.state,
        required: entry.required,
        hint: entry.hint,
        maxLength: field.maxLength,
        multiline: field.multiline,
        source: { type: entry.source.type, key: entry.source.type === 'field' ? entry.source.key : null },
        restricted: own.restricted,
        ...(differs && { suggestion: proposed!.value }),
      });
    }
    return fields;
  }

  /* ── Step 1: what the form would be filled with ───────────────────────────────────────────────────────────────── */

  async prepare(formId: string, dto: PrepareDto, user: AuthenticatedUser, locale: AppLocale) {
    const form = await this.forms.rowOrThrow(formId);
    const version = await this.editionOf(form, dto.versionId);
    const { mapping, fields: pdfFields } = await this.mappingOf(version, dto.mapping, user);
    const { context, period } = await this.contextFor(form, dto, user);
    const overlay = dto.overlay ? this.withOverlay(context, dto.overlay) : undefined;
    // What a photo said is shown beside the values of the record; a gap is filled with it, the rest is a suggestion.
    const fields = this.fieldsOf(mapping, pdfFields, context, overlay);

    const pending = await this.prisma.formSubmission.findMany({
      where: { formId, clientId: context.client.id, isActive: true, status: { in: [...PENDING_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, preparedOn: true, sentOn: true },
    });
    const warnings: PreparedWarning[] = [];
    if (!form.isActive) warnings.push({ code: 'form_inactive' });
    if (!context.client.isActive) warnings.push({ code: 'client_stopped' });
    if (form.subject === 'person' && !context.person) warnings.push({ code: 'no_people' });
    if (form.warnWhenPending && pending.length) warnings.push({ code: 'pending_exists', params: { count: pending.length } });
    if (!fields.length) warnings.push({ code: 'nothing_mapped' });
    if (version.isSample) warnings.push({ code: 'sample_form' });

    await this.auditReveal(fields, context, form);
    return {
      form: this.forms.view({ ...form, recipient: form.recipientId ? await this.prisma.addressBookEntry.findUnique({ where: { id: form.recipientId } }) : null }, { pending: pending.length, used: 0, lastUsed: null }, locale),
      version: OfficialFormsService.versionSummary(version),
      subject: { client: context.client, person: context.person, employee: context.employee, period },
      fields,
      warnings,
      pending: pending.map(row => ({ id: row.id, status: row.status, preparedOn: formatDay(row.preparedOn), sentOn: row.sentOn ? formatDay(row.sentOn) : null })),
    };
  }

  private withOverlay(context: SubjectContext, overlay: Record<string, unknown>): SubjectContext {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(overlay).slice(0, 200)) if (/^(client|person)\.[a-z][a-z0-9_]*$/.test(key) && value !== null && value !== undefined && value !== '') clean[key] = value;
    return this.sources.withOverlay(context, clean);
  }

  /** The audit trail says when a sensitive value (a BSN) was put on somebody's screen — here as in the person's own record. */
  private async auditReveal(fields: PreparedField[], context: SubjectContext, form: OfficialForm): Promise<void> {
    const shown = fields.filter(field => field.restricted && field.state === 'filled' && field.source.key);
    if (!shown.length) return;
    const keys = [...new Set(shown.map(field => field.source.key as string))];
    const person = keys.filter(key => key.startsWith('person.'));
    const client = keys.filter(key => key.startsWith('client.'));
    if (person.length && context.person) await this.audit.log({ action: 'revealed', entityType: 'person', entityId: context.person.id, entityLabel: context.person.name, meta: { fields: person.map(key => key.slice(7)), via: 'official_form', form: form.code } });
    if (client.length) await this.audit.log({ action: 'revealed', entityType: 'client', entityId: context.client.id, entityLabel: `${context.client.number} – ${context.client.name}`, meta: { fields: client.map(key => key.slice(7)), via: 'official_form', form: form.code } });
  }

  /* ── Step 2: the PDF with the values in it ────────────────────────────────────────────────────────────────────── */

  /** What goes into the PDF: only fields the mapping knows, in the type the field takes. */
  private pdfValues(values: Record<string, unknown>, mapping: FieldMapping[], pdfFields: PdfFieldInfo[]): { values: Record<string, PdfFieldValue>; typed: Map<string, FieldValue> } {
    const byName = new Map(pdfFields.map(field => [field.name, field]));
    const out: Record<string, PdfFieldValue> = {};
    const typed = new Map<string, FieldValue>();
    for (const entry of mapping) {
      if (!entry.source || !(entry.pdfField in values)) continue;
      const field = byName.get(entry.pdfField);
      if (!field) continue;
      const raw = values[entry.pdfField];
      let value: FieldValue;
      if (field.kind === 'checkbox') value = raw === true || (typeof raw === 'string' && /^(true|1|yes|ja|x|on)$/i.test(raw.trim()));
      else if (field.kind === 'list') value = (Array.isArray(raw) ? raw : [raw]).filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim().slice(0, 300));
      else value = typeof raw === 'string' ? raw.trim().slice(0, 5000) : typeof raw === 'number' ? String(raw) : '';
      out[entry.pdfField] = value;
      typed.set(entry.pdfField, value);
    }
    return { values: out, typed };
  }

  private async render(form: OfficialForm, version: OfficialFormVersion, values: Record<string, PdfFieldValue>, title: string) {
    const { buffer } = await this.files.bytes(version.fileId);
    return this.pdf.fill(buffer, values, { flatten: form.flatten, title }).catch(pdfProblem);
  }

  /** The PDF as it would be filed, without saving anything. */
  async preview(formId: string, dto: FillValuesDto, user: AuthenticatedUser, locale: AppLocale): Promise<{ bytes: Buffer; name: string }> {
    const form = await this.forms.rowOrThrow(formId);
    const version = await this.editionOf(form, dto.versionId);
    const { mapping, fields } = await this.mappingOf(version, dto.mapping, user);
    const { values } = this.pdfValues(dto.values, mapping, fields);
    const filled = await this.render(form, version, values, locale === 'nl' ? form.nameNl : form.nameEn);
    return { bytes: filled.bytes, name: `${(locale === 'nl' ? form.nameNl : form.nameEn).replace(/[\\/:*?"<>|]+/g, ' ').trim()}.pdf` };
  }

  /* ── Step 3: filing it and writing it in the log ──────────────────────────────────────────────────────────────── */

  async submit(formId: string, dto: SubmitDto, user: AuthenticatedUser, locale: AppLocale) {
    const form = await this.forms.rowOrThrow(formId);
    if (!form.isActive) throw new UnprocessableEntityException({ code: 'form_inactive', message: 'This form is switched off.' });
    const version = await this.editionOf(form, dto.versionId);
    const { mapping, fields } = await this.mappingOf(version, dto.mapping, user);
    const { context, period } = await this.contextFor(form, dto, user);
    const { values, typed } = this.pdfValues(dto.values, mapping, fields);

    // A required field must have something in it.
    const missing: Record<string, string> = {};
    for (const entry of mapping) if (entry.source && entry.required && !(entry.pdfField in values ? !isEmptyValue(typed.get(entry.pdfField)!) : false)) missing[`values.${entry.pdfField}`] = 'validation.required';
    if (Object.keys(missing).length) throw validationFailed(missing);

    const recipientId = dto.recipientId === undefined ? form.recipientId : dto.recipientId;
    const recipient = recipientId ? await this.prisma.addressBookEntry.findUnique({ where: { id: recipientId } }) : null;
    if (recipientId && !recipient) throw validationFailed({ recipientId: 'validation.invalid' });

    // The form is personal data when a sensitive value is in it.
    const hasPersonalData = mapping.some(entry => {
      if (!entry.source || entry.source.type === 'fixed' || entry.source.type === 'ask') return false;
      const keys = entry.source.type === 'field' ? [entry.source.key] : placeholdersOf(entry.source.template);
      return keys.some(key => this.sources.resolve(context, key).restricted) && typed.has(entry.pdfField) && !isEmptyValue(typed.get(entry.pdfField)!);
    });

    const documentLocale = this.documentLocale();
    const formName = documentLocale === 'nl' ? form.nameNl : form.nameEn;
    const today = todayInAmsterdam();
    const filled = await this.render(form, version, values, formName);
    const type = await this.types.byCode(form.docType);
    const folderId = await this.folderFor(context.client.id, form.folderCode ?? type?.folderCode ?? null);
    const name = await this.fileName(form, formName, context, today, folderId);
    const stored = await this.files.store(filled.bytes, {
      name,
      purpose: hasPersonalData ? 'form_document_personal' : 'form_document',
      entityType: 'client',
      entityId: context.client.id,
      ...(folderId && { folderId }),
      userId: user.id,
      meta: { docType: type?.code ?? form.docType, docDate: today },
      ...(context.employee && { links: [{ entityType: 'employee', entityId: context.employee.id }] }),
    });

    // The values in the log are the ones anybody who may see the log may see: the sensitive ones are in the PDF only.
    const restrictedFields = new Set(
      mapping.filter(entry => entry.source && entry.source.type !== 'fixed' && entry.source.type !== 'ask' && (entry.source.type === 'field' ? [entry.source.key] : placeholdersOf(entry.source.template)).some(key => this.sources.resolve(context, key).restricted)).map(entry => entry.pdfField),
    );
    const snapshot = Object.fromEntries([...typed].filter(([key, value]) => !restrictedFields.has(key) && !isEmptyValue(value)));

    const row = await this.prisma.formSubmission.create({
      data: {
        formId,
        versionId: version.id,
        clientId: context.client.id,
        employeeId: context.employee?.id ?? null,
        personId: context.person?.id ?? null,
        periodStart: period ? new Date(`${period.start}T00:00:00.000Z`) : null,
        periodEnd: period ? new Date(`${period.end}T00:00:00.000Z`) : null,
        fileId: stored.id,
        status: 'prepared',
        preparedOn: new Date(`${today}T00:00:00.000Z`),
        recipientId: recipient?.id ?? null,
        recipientText: recipient ? addressLines(recipient, 'nl').join('\n') : '',
        reference: (dto.reference ?? '').trim(),
        note: (dto.note ?? '').trim(),
        values: snapshot as Prisma.InputJsonObject,
        hasPersonalData,
        usedAi: dto.usedAi === true,
        searchText: [formName, form.nameNl, form.nameEn, form.authorityCode, context.client.number, context.client.name, context.person?.name ?? '', dto.reference ?? '', dto.note ?? ''].map(fold).filter(Boolean).join(' '),
        createdById: user.id,
      },
    });
    await this.audit.log({
      action: 'created',
      entityType: SUBMISSION_ENTITY,
      entityId: row.id,
      entityLabel: `${formName} – ${context.client.number} ${context.client.name}`,
      after: { form: form.code, edition: version.version, client: context.client.number, file: stored.name, personalData: hasPersonalData },
    });
    if (dto.markSent) await this.submissions.update(row.id, { status: 'sent' }, user, locale);
    return {
      ...(await this.submissions.one(row.id, user, locale)),
      warnings: { unknown: filled.unknown, truncated: filled.truncated, failed: filled.failed },
    };
  }

  /** `Melding loonheffingen_042_12-10-2026.pdf` — the pattern of the form; never the same as another file in the folder (`… (2).pdf`). */
  private async fileName(form: OfficialForm, formName: string, context: SubjectContext, today: string, folderId: string | null): Promise<string> {
    const made = nameFromPattern(form.namePattern, { number: context.client.number, client: context.client.name, worker: context.person?.name ?? null, type: formName, date: today, original: formName }) ?? `${formName}_${context.client.number}`;
    const taken = new Set((await this.prisma.storedFile.findMany({ where: { isActive: true, isCurrent: true, folderId, clientId: context.client.id }, select: { name: true } })).map(file => file.name.toLowerCase()));
    if (!taken.has(`${made}.pdf`.toLowerCase())) return `${made}.pdf`;
    for (let number = 2; number < 100; number += 1) if (!taken.has(`${made} (${number}).pdf`.toLowerCase())) return `${made} (${number}).pdf`;
    return `${made} (${Date.now()}).pdf`;
  }

  private async folderFor(clientId: string, code: string | null): Promise<string | null> {
    const standard = code ? await this.prisma.folder.findFirst({ where: { clientId, templateCode: code, employeeId: null, isActive: true }, select: { id: true } }) : null;
    if (standard) return standard.id;
    return (await this.prisma.folder.findFirst({ where: { clientId, parentId: null, isActive: true }, select: { id: true } }))?.id ?? null;
  }
}
