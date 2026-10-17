import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { isValidDay } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma, type InspectionItem } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { itemHelp, itemLabel, sectionName, type ChecklistItem } from './checklist-doc.js';
import type { CustomItemDto, ItemDecisionDto, ItemFileDto } from './dto/inspections.dto.js';
import { InspectionContextService, type ChecklistEvaluation, type EvaluateRequest, type SampleWorker } from './inspection-context.service.js';
import { InspectionListsService } from './inspection-lists.service.js';
import { emptySummary, type ItemResult, type ItemState, type Summary, type UnitsResult, type UsedFile } from './inspection-matching.js';
import { addCustomLines, choicesOf, customItemsOf, customState, day, docOf, isOpen, toDay, type InspectionRow } from './inspection-rows.js';
import { INSPECTION_ENTITY, MAX_CUSTOM_ITEMS } from './inspections.constants.js';

export interface FileView {
  id: string;
  name: string;
  size: number;
  type: { code: string; name: string } | null;
  docDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  source: 'matched' | 'added';
  /** The period unit it stands for (`2026-Q1`). */
  unit: string | null;
  isActive: boolean;
}

export interface SubjectView {
  id: string;
  name: string;
  state: ItemState;
  files: FileView[];
  hiddenFiles: number;
  newestDate: string | null;
  ageMonths: number | null;
  units: UnitsResult | null;
}

export interface ItemView {
  /** `2`, `9d`; `custom:<id>` for a line added by hand. */
  key: string;
  code: string | null;
  /** The id of a line added by hand. */
  id: string | null;
  custom: boolean;
  section: string | null;
  label: string;
  help: string;
  scope: ChecklistItem['scope'] | null;
  docTypes: Array<{ code: string; name: string }>;
  period: ChecklistItem['period'] | null;
  cutoff: ChecklistItem['cutoff'];
  cutoffDate: string | null;
  maxAgeMonths: number | null;
  onSite: boolean;
  digital: boolean;
  optional: boolean;
  bsnAllowed: boolean;
  state: ItemState;
  /** The line is switched on: the inspector asks for it this time. */
  applicable: boolean;
  notApplicableBecause: ItemResult['notApplicableBecause'];
  decision: string | null;
  /** How often the inspector asks for the line (the checklist's rule) and when the client's last inspection did. */
  ask: ChecklistItem['ask'];
  askEveryMonths: number | null;
  lastAsked: string | null;
  askAgainFrom: string | null;
  note: string;
  dueDate: string | null;
  files: FileView[];
  /** Documents of the line the person may not open (they are counted, not shown). */
  hiddenFiles: number;
  /** Documents that were taken off the line (so they can be put back). */
  excluded: FileView[];
  subjects: SubjectView[] | null;
  units: UnitsResult | null;
  newestDate: string | null;
  ageMonths: number | null;
  /** Documents of the right type that are of other periods. */
  outside: number;
}

export interface ChecklistView {
  asOf: string;
  /** The checklist is as it stood when the inspection was closed. */
  frozen: boolean;
  version: { id: string; number: number; label: string; template: { id: string; name: string } } | null;
  summary: Summary;
  sections: Array<{ key: string; name: string; folder: boolean; items: ItemView[] }>;
  custom: ItemView[];
  sample: SampleWorker[];
  parents: Array<{ id: string; number: string; name: string }>;
}

/** What is kept of the checklist when an inspection is closed. */
interface Snapshot {
  takenAt: string;
  asOf: string;
  summary: Summary;
  items: ItemResult[];
  sample: SampleWorker[];
  parents: Array<{ id: string; number: string; name: string }>;
}

const isSnapshot = (value: unknown): value is Snapshot => Boolean(value) && typeof value === 'object' && Array.isArray((value as Snapshot).items);

/**
 * The checklist of one inspection: every line of the edition it was prepared with, what the documents say about it, and what people decided (not applicable, done, a note, a
 * document put on it or taken off it). Open inspections are worked out from the documents every time they are looked at; a closed one is shown as it was when it was closed.
 */
@Injectable()
export class InspectionChecklistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly context: InspectionContextService,
    private readonly types: DocumentTypesService,
    private readonly lists: InspectionListsService,
  ) {}

  /* ── Working it out ───────────────────────────────────────────────────────────────────────────────────────────── */

  /** The inspection's checklist evaluated now (or the snapshot of a closed one). */
  async evaluation(row: InspectionRow): Promise<{ evaluation: ChecklistEvaluation; frozen: boolean }> {
    if (!isOpen(row) && isSnapshot(row.snapshot)) {
      const snapshot = row.snapshot;
      return { evaluation: { items: snapshot.items, summary: snapshot.summary, sample: snapshot.sample ?? [], parents: snapshot.parents ?? [] }, frozen: true };
    }
    const answers = await this.context.evaluate([this.request(row)]);
    return { evaluation: answers.get(row.id) ?? { items: [], summary: emptySummary(), sample: [], parents: [] }, frozen: false };
  }

  /** What the matching is asked for one inspection: its checklist, its day, what people decided, and which inspection it is (for when lines were last asked). */
  private request(row: InspectionRow, choices = choicesOf(row.items)): EvaluateRequest {
    return { key: row.id, clientId: row.clientId, asOf: day(row.date)!, items: docOf(row).items, choices, templateId: row.version?.template.id ?? null, inspectionId: row.id };
  }

  /** The numbers behind a list of inspections (null = no checklist, and nothing added by hand). */
  async summaries(rows: readonly InspectionRow[]): Promise<Map<string, Summary | null>> {
    const out = new Map<string, Summary | null>();
    const live = rows.filter(row => (isOpen(row) || !isSnapshot(row.snapshot)) && row.version);
    const answers = await this.context.evaluate(live.map(row => this.request(row)));
    for (const row of rows) {
      const custom = customItemsOf(row.items);
      const base = !isOpen(row) && isSnapshot(row.snapshot) ? row.snapshot.summary : (answers.get(row.id)?.summary ?? null);
      out.set(row.id, base ? addCustomLines(base, custom) : custom.length ? addCustomLines(emptySummary(), custom) : null);
    }
    return out;
  }

  /** What is written down when an inspection is closed: the checklist as it stands. */
  async snapshotOf(row: InspectionRow): Promise<Prisma.InputJsonValue> {
    const answers = await this.context.evaluate([this.request(row)]);
    const found = answers.get(row.id);
    const snapshot: Snapshot = { takenAt: new Date().toISOString(), asOf: day(row.date)!, summary: found?.summary ?? emptySummary(), items: found?.items ?? [], sample: found?.sample ?? [], parents: found?.parents ?? [] };
    return JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue;
  }

  /* ── The view ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  async build(row: InspectionRow, user: AuthenticatedUser, locale: AppLocale): Promise<ChecklistView> {
    const doc = docOf(row);
    const { evaluation, frozen } = await this.evaluation(row);
    const choices = choicesOf(row.items);
    const custom = customItemsOf(row.items);
    const byCode = new Map(evaluation.items.map(result => [result.code, result]));

    const ids = new Set<string>();
    for (const result of evaluation.items) {
      for (const file of result.files) ids.add(file.id);
      for (const subject of result.subjects ?? []) for (const file of subject.files) ids.add(file.id);
    }
    for (const choice of choices.values()) for (const id of choice.excluded) ids.add(id);
    const [files, types] = await Promise.all([
      ids.size ? this.prisma.storedFile.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, size: true, docType: true, docDate: true, periodFrom: true, periodTo: true, area: true, isActive: true } }) : [],
      this.types.codeMap(),
    ]);
    const fileById = new Map(files.map(file => [file.id, file]));
    const typeName = (code: string): string => (types.get(code) ? DocumentTypesService.nameIn(types.get(code)!, locale) : code);
    const canOpen = (file: { area: string | null }): boolean => Boolean(file.area && matrixAllows(user.matrix, `${file.area}.view`));
    const view = (used: UsedFile): FileView | null => {
      const file = fileById.get(used.id);
      if (!file || !canOpen(file)) return null;
      return { id: file.id, name: file.name, size: file.size, type: file.docType ? { code: file.docType, name: typeName(file.docType) } : null, docDate: day(file.docDate), periodFrom: day(file.periodFrom), periodTo: day(file.periodTo), source: used.source, unit: used.unit, isActive: file.isActive };
    };
    const split = (used: readonly UsedFile[]): { files: FileView[]; hidden: number } => {
      const shown = used.map(view).filter((entry): entry is FileView => entry !== null);
      return { files: shown, hidden: used.length - shown.length };
    };

    const line = (item: ChecklistItem): ItemView => {
      const result = byCode.get(item.code);
      const stored = row.items.find(entry => entry.code === item.code);
      const choice = choices.get(item.code);
      const used = split(result?.files ?? []);
      const excluded = [...(choice?.excluded ?? [])].map(id => view({ id, source: 'matched', unit: null })).filter((entry): entry is FileView => entry !== null);
      return {
        key: item.code,
        code: item.code,
        id: null,
        custom: false,
        section: item.section,
        label: itemLabel(item, locale),
        help: itemHelp(item, locale),
        scope: item.scope,
        docTypes: item.docTypes.map(code => ({ code, name: typeName(code) })),
        period: item.period,
        cutoff: item.cutoff,
        cutoffDate: result?.cutoffDate ?? null,
        maxAgeMonths: item.maxAgeMonths,
        onSite: item.onSite,
        digital: item.digital,
        optional: item.optional,
        bsnAllowed: item.bsnAllowed,
        state: result?.state ?? 'manual',
        applicable: result?.applicable ?? true,
        notApplicableBecause: result?.notApplicableBecause ?? null,
        decision: stored?.decision ?? null,
        ask: item.ask,
        askEveryMonths: item.askEveryMonths,
        lastAsked: result?.lastAsked ?? null,
        askAgainFrom: result?.askAgainFrom ?? null,
        note: stored?.note ?? '',
        dueDate: day(stored?.dueDate ?? null),
        files: used.files,
        hiddenFiles: used.hidden,
        excluded,
        subjects: (result?.subjects ?? null)?.map(subject => {
          const own = split(subject.files);
          return { id: subject.id, name: subject.name, state: subject.state, files: own.files, hiddenFiles: own.hidden, newestDate: subject.newestDate, ageMonths: subject.ageMonths, units: subject.units } satisfies SubjectView;
        }) ?? null,
        units: result?.units ?? null,
        newestDate: result?.newestDate ?? null,
        ageMonths: result?.ageMonths ?? null,
        outside: result?.outside ?? 0,
      };
    };

    const customView = (entry: InspectionItem): ItemView => ({
      key: `custom:${entry.id}`,
      code: null,
      id: entry.id,
      custom: true,
      section: null,
      label: entry.label,
      help: '',
      scope: null,
      docTypes: [],
      period: null,
      cutoff: null,
      cutoffDate: null,
      maxAgeMonths: null,
      onSite: true,
      digital: false,
      optional: false,
      bsnAllowed: false,
      state: customState(entry.decision),
      applicable: entry.decision !== 'not_applicable',
      notApplicableBecause: entry.decision === 'not_applicable' ? 'decision' : null,
      decision: entry.decision,
      ask: 'every',
      askEveryMonths: null,
      lastAsked: null,
      askAgainFrom: null,
      note: entry.note,
      dueDate: day(entry.dueDate),
      files: [],
      hiddenFiles: 0,
      excluded: [],
      subjects: null,
      units: null,
      newestDate: null,
      ageMonths: null,
      outside: 0,
    });

    return {
      asOf: day(row.date)!,
      frozen,
      version: row.version ? { id: row.version.id, number: row.version.version, label: row.version.label, template: { id: row.version.template.id, name: locale === 'nl' ? row.version.template.nameNl : row.version.template.nameEn } } : null,
      summary: addCustomLines(evaluation.summary, custom),
      sections: doc.sections.map(section => ({ key: section.key, name: sectionName(section, locale), folder: section.folder, items: doc.items.filter(item => item.section === section.key).map(line) })),
      custom: custom.map(customView),
      sample: evaluation.sample,
      parents: evaluation.parents,
    };
  }

  /* ── Deciding about a line ────────────────────────────────────────────────────────────────────────────────────── */

  private assertEditable(row: InspectionRow): void {
    if (!row.isActive) throw new ConflictException({ code: 'inspection_inactive', message: 'This inspection is switched off.' });
    if (!isOpen(row)) throw new ConflictException({ code: 'inspection_closed', message: 'This inspection is closed — open it again to change the checklist.' });
  }

  private label(row: InspectionRow): string {
    return `${row.number} – ${row.client.number} ${row.client.name}`;
  }

  private lineOrThrow(row: InspectionRow, code: string): ChecklistItem {
    const item = docOf(row).items.find(entry => entry.code === code);
    if (!item) throw new NotFoundException({ code: 'not_found', message: 'This line is not on the checklist.' });
    return item;
  }

  /** A row for a line of the checklist exists only while it holds a decision, a note, a deadline or a document. */
  private async tidy(itemId: string): Promise<void> {
    const item = await this.prisma.inspectionItem.findUnique({ where: { id: itemId }, include: { files: { select: { id: true } } } });
    if (item?.code && !item.decision && !item.note && !item.dueDate && !item.files.length) await this.prisma.inspectionItem.delete({ where: { id: itemId } });
  }

  async setItem(row: InspectionRow, code: string, dto: ItemDecisionDto, user: AuthenticatedUser): Promise<void> {
    this.assertEditable(row);
    const item = this.lineOrThrow(row, code);
    const problems: Record<string, string> = {};
    if (dto.dueDate && !isValidDay(dto.dueDate)) problems.dueDate = 'validation.invalid';
    if (Object.keys(problems).length) throw validationFailed(problems);
    const existing = row.items.find(entry => entry.code === code);
    let decision = dto.decision === undefined ? (existing?.decision ?? null) : dto.decision;
    // Unticking a line keeps it on: when it would be off by itself (its condition or rule), it stays switched on by hand.
    if (decision === null && existing?.decision === 'done' && !(await this.automaticallyOn(row, [code])).get(code)) decision = 'asked';
    const note = dto.note === undefined ? (existing?.note ?? '') : dto.note.trim();
    const dueDate = dto.dueDate === undefined ? (existing?.dueDate ?? null) : dto.dueDate ? toDay(dto.dueDate) : null;
    const saved = await this.prisma.inspectionItem.upsert({
      where: { inspectionId_code: { inspectionId: row.id, code } },
      create: { inspectionId: row.id, code, decision, note, dueDate, updatedById: user.id },
      update: { decision, note, dueDate, updatedById: user.id },
    });
    await this.tidy(saved.id);
    const diff = AuditService.changes({ decision: existing?.decision ?? null, note: existing?.note ?? '', dueDate: day(existing?.dueDate ?? null) }, { decision, note, dueDate: day(dueDate) });
    if (Object.keys(diff.after).length) {
      await this.audit.log({ action: 'updated', entityType: INSPECTION_ENTITY, entityId: row.id, entityLabel: this.label(row), before: { line: item.code, ...diff.before }, after: { line: item.code, ...diff.after } });
    }
  }

  /**
   * Switches lines on (the inspector asks for them this time) or off. Switching on leaves a line to itself when it would be on anyway, and switches it on by hand
   * (`asked`) when its condition or its rule ("once a year", "only when switched on") would leave it off. Switching off does the reverse — so on and off again is
   * where it started — and forgets a tick ("done").
   */
  /** Whether these lines would be on by themselves — worked out with their own decisions left out. */
  private async automaticallyOn(row: InspectionRow, codes: readonly string[]): Promise<Map<string, boolean>> {
    const choices = new Map(choicesOf(row.items));
    for (const code of codes) {
      const choice = choices.get(code);
      if (choice) choices.set(code, { ...choice, decision: null });
    }
    const answer = (await this.context.evaluate([this.request(row, choices)])).get(row.id);
    return new Map((answer?.items ?? []).map(result => [result.code, result.applicable]));
  }

  async switchLines(row: InspectionRow, codes: readonly string[], on: boolean, user: AuthenticatedUser): Promise<void> {
    this.assertEditable(row);
    const lines = [...new Set(codes)].map(code => this.lineOrThrow(row, code));
    const automatic = await this.automaticallyOn(row, lines.map(line => line.code));

    const changed: Array<{ code: string; before: string | null; after: string | null }> = [];
    for (const line of lines) {
      const existing = row.items.find(entry => entry.code === line.code);
      const before = existing?.decision ?? null;
      const byItself = automatic.get(line.code) ?? true;
      // On: kept as it is when it is on by hand already, else switched on by hand only when it would be off by itself. Off: back to itself when that is off.
      const after = on ? (before === 'asked' || before === 'done' ? before : byItself ? null : 'asked') : byItself ? 'not_applicable' : null;
      if (after === before) continue;
      const saved = await this.prisma.inspectionItem.upsert({
        where: { inspectionId_code: { inspectionId: row.id, code: line.code } },
        create: { inspectionId: row.id, code: line.code, decision: after, updatedById: user.id },
        update: { decision: after, updatedById: user.id },
      });
      await this.tidy(saved.id);
      changed.push({ code: line.code, before, after });
    }
    if (!changed.length) return;
    const word = (decision: string | null) => (decision === 'not_applicable' ? 'off' : decision === 'asked' ? 'on' : decision === 'done' ? 'done' : 'automatic');
    await this.audit.log({
      action: 'updated',
      entityType: INSPECTION_ENTITY,
      entityId: row.id,
      entityLabel: this.label(row),
      before: Object.fromEntries(changed.map(entry => [`line ${entry.code}`, word(entry.before)])),
      after: Object.fromEntries(changed.map(entry => [`line ${entry.code}`, word(entry.after)])),
    });
  }

  /** Puts a document on a line (`added`), takes it off (`excluded`) or forgets the choice (`none`). */
  async setFile(row: InspectionRow, code: string, dto: ItemFileDto, user: AuthenticatedUser): Promise<void> {
    this.assertEditable(row);
    const item = this.lineOrThrow(row, code);
    if (dto.kind === 'added' && item.scope !== 'client') throw validationFailed({ kind: 'validation.invalid' });
    const file = await this.prisma.storedFile.findUnique({ where: { id: dto.fileId }, select: { id: true, name: true, area: true, isActive: true, clientId: true, links: { where: { entityType: 'client', entityId: row.clientId }, select: { id: true } } } });
    if (!file || !file.isActive) throw validationFailed({ fileId: 'validation.invalid' });
    if (!file.area || !matrixAllows(user.matrix, `${file.area}.view`)) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
    // Documents of the client (and of its people), nobody else's.
    if (file.clientId !== row.clientId && !file.links.length) throw validationFailed({ fileId: 'validation.invalid' });

    const stored = await this.prisma.inspectionItem.upsert({ where: { inspectionId_code: { inspectionId: row.id, code } }, create: { inspectionId: row.id, code, updatedById: user.id }, update: {} });
    const existing = await this.prisma.inspectionItemFile.findUnique({ where: { itemId_fileId: { itemId: stored.id, fileId: file.id } } });
    if (dto.kind === 'none') {
      if (existing) await this.prisma.inspectionItemFile.delete({ where: { id: existing.id } });
    } else if (existing) {
      if (existing.kind !== dto.kind) await this.prisma.inspectionItemFile.update({ where: { id: existing.id }, data: { kind: dto.kind } });
    } else {
      await this.prisma.inspectionItemFile.create({ data: { itemId: stored.id, fileId: file.id, kind: dto.kind, createdById: user.id } });
    }
    await this.tidy(stored.id);
    if ((existing?.kind ?? 'none') !== dto.kind) {
      await this.audit.log({ action: 'updated', entityType: INSPECTION_ENTITY, entityId: row.id, entityLabel: this.label(row), before: { line: code, document: existing ? `${existing.kind}: ${file.name}` : null }, after: { line: code, document: dto.kind === 'none' ? null : `${dto.kind}: ${file.name}` } });
    }
  }

  /* ── Lines added by hand ──────────────────────────────────────────────────────────────────────────────────────── */

  async addCustom(row: InspectionRow, dto: CustomItemDto, user: AuthenticatedUser): Promise<InspectionItem> {
    this.assertEditable(row);
    const label = dto.label?.trim() ?? '';
    const problems: Record<string, string> = {};
    if (!label) problems.label = 'validation.required';
    if (dto.dueDate && !isValidDay(dto.dueDate)) problems.dueDate = 'validation.invalid';
    if (Object.keys(problems).length) throw validationFailed(problems);
    if (customItemsOf(row.items).length >= MAX_CUSTOM_ITEMS) throw new ConflictException({ code: 'too_many_lines', message: 'This inspection has as many extra lines as it can hold.' });
    const last = Math.max(0, ...row.items.map(entry => entry.sortOrder));
    const created = await this.prisma.inspectionItem.create({ data: { inspectionId: row.id, code: null, label, decision: dto.decision ?? null, note: dto.note?.trim() ?? '', dueDate: dto.dueDate ? toDay(dto.dueDate) : null, sortOrder: last + 10, updatedById: user.id } });
    await this.audit.log({ action: 'updated', entityType: INSPECTION_ENTITY, entityId: row.id, entityLabel: this.label(row), before: { extraLine: null }, after: { extraLine: label } });
    return created;
  }

  private customOrThrow(row: InspectionRow, id: string): InspectionItem {
    const found = row.items.find(entry => entry.id === id && !entry.code);
    if (!found) throw new NotFoundException({ code: 'not_found', message: 'Line not found' });
    return found;
  }

  async updateCustom(row: InspectionRow, id: string, dto: CustomItemDto, user: AuthenticatedUser): Promise<void> {
    this.assertEditable(row);
    const found = this.customOrThrow(row, id);
    const problems: Record<string, string> = {};
    const label = dto.label === undefined ? found.label : dto.label.trim();
    if (!label) problems.label = 'validation.required';
    if (dto.dueDate && !isValidDay(dto.dueDate)) problems.dueDate = 'validation.invalid';
    if (Object.keys(problems).length) throw validationFailed(problems);
    const next = { label, decision: dto.decision === undefined ? found.decision : dto.decision, note: dto.note === undefined ? found.note : dto.note.trim(), dueDate: dto.dueDate === undefined ? found.dueDate : dto.dueDate ? toDay(dto.dueDate) : null };
    await this.prisma.inspectionItem.update({ where: { id }, data: { ...next, updatedById: user.id } });
    const diff = AuditService.changes({ label: found.label, decision: found.decision, note: found.note, dueDate: day(found.dueDate) }, { ...next, dueDate: day(next.dueDate) });
    if (Object.keys(diff.after).length) await this.audit.log({ action: 'updated', entityType: INSPECTION_ENTITY, entityId: row.id, entityLabel: this.label(row), before: { extraLine: found.label, ...diff.before }, after: { extraLine: label, ...diff.after } });
  }

  async removeCustom(row: InspectionRow, id: string): Promise<void> {
    this.assertEditable(row);
    const found = this.customOrThrow(row, id);
    await this.prisma.inspectionItem.delete({ where: { id } });
    await this.audit.log({ action: 'updated', entityType: INSPECTION_ENTITY, entityId: row.id, entityLabel: this.label(row), before: { extraLine: found.label }, after: { extraLine: null } });
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The checklist with what is ready, as a table (Excel, PDF or Word). */
  async exportTable(row: InspectionRow, user: AuthenticatedUser, locale: AppLocale): Promise<ExportTable> {
    const view = await this.build(row, user, locale);
    const states = await this.lists.names('inspection_item_state', locale);
    const nl = locale === 'nl';
    const rows: Array<Record<string, unknown>> = [];
    const push = (item: ItemView, section: string) => {
      const documents = item.subjects ? item.subjects.map(subject => `${subject.name}: ${subject.files.map(file => file.name).join(', ') || '–'}`).join('\n') : item.files.map(file => file.name).join('\n');
      rows.push({
        code: item.code ?? '',
        section,
        item: item.label,
        asked: item.applicable,
        state: states.get(item.state) ?? item.state,
        documents,
        docDate: item.newestDate,
        onSite: item.onSite,
        digital: item.digital,
        note: item.note,
      });
    };
    for (const section of view.sections) for (const item of section.items) push(item, section.name);
    for (const item of view.custom) push(item, nl ? 'Extra regels' : 'Extra lines');
    const summary = view.summary;
    return {
      title: `${nl ? 'Controlelijst' : 'Inspection checklist'} ${row.client.number} ${row.client.name}`,
      subtitle: `${row.number} · ${nl ? 'datum' : 'date'} ${day(row.date)!.split('-').reverse().join('-')} · ${nl ? `gereed ${summary.ready} van ${summary.total} (${summary.percent}%)` : `ready ${summary.ready} of ${summary.total} (${summary.percent}%)`}`,
      locale,
      columns: [
        { key: 'code', header: nl ? 'Nr.' : 'No.', width: 8 },
        { key: 'section', header: nl ? 'Onderdeel' : 'Part', width: 24 },
        { key: 'item', header: nl ? 'Wat de inspecteur vraagt' : 'What the inspector asks for', width: 52 },
        { key: 'asked', header: nl ? 'Gevraagd' : 'Asked', type: 'boolean', width: 10 },
        { key: 'state', header: 'Status', width: 18 },
        { key: 'documents', header: nl ? 'Documenten' : 'Documents', width: 44 },
        { key: 'docDate', header: nl ? 'Nieuwste datum' : 'Newest date', type: 'date', width: 14 },
        { key: 'onSite', header: nl ? 'Ter inzage' : 'On site', type: 'boolean', width: 10 },
        { key: 'digital', header: nl ? 'Kopie digitaal' : 'Digital copy', type: 'boolean', width: 12 },
        { key: 'note', header: nl ? 'Opmerking' : 'Note', width: 30 },
      ],
      rows,
    };
  }
}
