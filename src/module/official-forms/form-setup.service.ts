import { Injectable, Logger } from '@nestjs/common';
import type { OfficialForm, OfficialFormVersion, Prisma } from '../../generated/prisma/client.js';
import { AiService } from '../../lib/ai/ai.service.js';
import { AiError, type AiInputFile } from '../../lib/ai/ai.types.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { PdfService } from '../../lib/pdf/pdf.service.js';
import type { PdfArea, PdfBox, PdfFieldInfo, PdfPageLayout } from '../../lib/pdf/pdf.types.js';
import { QueueProcessor, QueueWorker, type QueueJobContext } from '../../lib/queue/queue.decorator.js';
import { QueueService } from '../../lib/queue/queue.service.js';
import { FilesService } from '../files/files.service.js';
import { isFillable, nextBoxName, readFields, sanitizeBoxes } from './form-fields.js';
import { TEXT_FORMATS, TEST_OPS, emptyMapping, placeholdersOf, readMapping, sanitizeMapping, type FieldMapping, type SourceRef, type TestOp, type TextFormat } from './form-mapping.js';
import { readSetup, withContext, type FormSetup } from './form-setup.js';
import { FormSourcesService } from './form-sources.service.js';
import { OFFICIAL_FORM_ENTITY, PERIOD_KINDS, QUEUE_FORM_SETUP, SETUP_MAX_PAGES, SUBJECTS } from './official-forms.constants.js';

/* ── What the AI is asked and how it answers ────────────────────────────────────────────────────────────────────── */

const FORM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name_nl', 'name_en', 'authority_code', 'subject', 'period', 'description_nl', 'description_en'],
  properties: {
    name_nl: { type: 'string', description: 'The name of the form in Dutch, as printed on it (without the code).' },
    name_en: { type: 'string', description: 'The same name in English.' },
    authority_code: { type: 'string', description: 'The code printed on the form (for example "LH 011 - 1Z*1FOL" or "CA 041"); empty when there is none.' },
    subject: { type: 'string', enum: [...SUBJECTS], description: 'Who the form is about: client = the company itself; person = an owner, director or partner of it; worker = one of its employees.' },
    period: { type: 'string', enum: [...PERIOD_KINDS], description: 'none; year = it is about one calendar year; range = it is about a period from – to.' },
    description_nl: { type: 'string', description: 'One sentence in Dutch: what the form is for.' },
    description_en: { type: 'string', description: 'The same sentence in English.' },
  },
} as const;

/** How one field or box is filled — the same words for both kinds of PDF. */
const LINK_PROPERTIES = {
  label: { type: 'string', description: 'The question as printed on the form, short, in the language of the form.' },
  how: { type: 'string', enum: ['source', 'compose', 'fixed', 'ask'], description: 'source = one value of the records; compose = several values in one text; fixed = always the same text; ask = typed by the person filling the form in.' },
  source: { type: 'string', description: 'how=source (and every check box): the key of the value, exactly as in the list of sources. Empty otherwise.' },
  template: { type: 'string', description: 'how=compose: a text with keys in braces, for example "{person.initials} {person.surname}". Empty otherwise.' },
  value: { type: 'string', description: 'how=fixed: the text. Empty otherwise.' },
  format: { type: 'string', enum: [...TEXT_FORMATS], description: 'How a text is written: as_is unless the form asks otherwise (date_dmy for dates as dd-mm-jjjj, digits for numbers without dots or spaces, upper for capitals, initials, iban_groups …).' },
  tick_when: { type: 'string', enum: TEST_OPS.filter(op => op !== 'in'), description: 'Check boxes: when it is ticked — truthy (the value is yes), falsy, eq / ne (the value is / is not tick_value), filled, empty. truthy for other kinds.' },
  tick_value: { type: 'string', description: 'Check boxes with eq or ne: the code of the choice that ticks it (for example "bv"). Empty otherwise.' },
  required: { type: 'boolean', description: 'The form cannot be sent without this answer.' },
} as const;

const LINK_REQUIRED = Object.keys(LINK_PROPERTIES);

const FIELDS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['form', 'links'],
  properties: {
    form: FORM_SCHEMA,
    links: {
      type: 'array',
      description: 'One entry for every field that is filled in or asked; fields that stay empty are left out.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', ...LINK_REQUIRED, 'choices'],
        properties: {
          field: { type: 'integer', description: 'The number of the field in the list of fields.' },
          ...LINK_PROPERTIES,
          choices: {
            type: 'array',
            description: 'Radio groups and drop-downs: which option goes with which code of the source (empty for other kinds).',
            items: { type: 'object', additionalProperties: false, required: ['code', 'option'], properties: { code: { type: 'string' }, option: { type: 'string' } } },
          },
        },
      },
    },
  },
} as const;

const BOXES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['form', 'boxes'],
  properties: {
    form: FORM_SCHEMA,
    boxes: {
      type: 'array',
      description: 'One entry for every answer that is written onto the form; places that stay empty are left out.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['page', 'area', 'x', 'y', 'width', 'height', 'kind', 'cells', 'multiline', ...LINK_REQUIRED],
        properties: {
          page: { type: 'integer', description: 'The page, counting from 1.' },
          area: { type: 'string', description: 'The id of the place to write from the list (for example "p1-a7"). Empty when the answer goes where no place is listed: then give x, y, width and height.' },
          x: { type: 'number', description: 'Points from the left edge of the page (only when area is empty, else 0).' },
          y: { type: 'number', description: 'Points from the top edge of the page (only when area is empty, else 0).' },
          width: { type: 'number' },
          height: { type: 'number' },
          kind: { type: 'string', enum: ['text', 'checkbox'] },
          cells: { type: 'integer', description: 'A row of letter boxes with one character each: how many boxes; 0 otherwise.' },
          multiline: { type: 'boolean', description: 'A tall box for a longer text over several lines.' },
          ...LINK_PROPERTIES,
        },
      },
    },
  },
} as const;

const INSTRUCTIONS = [
  'You set up a Dutch form (usually one of the tax authority, the Belastingdienst, or of a bank) so that an accounting office can fill it in automatically from its records.',
  'The office fills in forms for its clients: the client is a company (often a sole trader); a form can also be about a person of the company (owner, director, partner) or about one of its workers.',
  'Decide for every question on the form where its answer comes from: one value of the records ("source", with a key from the list of sources — never invent a key), several values in one text ("compose"),',
  'always the same text ("fixed"), or something only a person can answer ("ask": a reason, an amount that is not in the records, a choice the records do not know).',
  'Leave out what must stay empty: signatures, boxes "for the tax authority" / "in te vullen door de Belastingdienst", questions about other people than the subject, explanations.',
  'Prefer the most exact source: the client\'s own number fields for KvK, VAT, RSIN and payroll-tax numbers; person.* for the person who signs or the person the form is about; office.* only for the accounting office itself (an intermediary, "gemachtigde", "intermediair").',
  'Dates are written as the form shows them (usually date_dmy = dd-mm-jjjj); numbers in letter boxes without dots or spaces (digits); postcodes as asked.',
  'Use form.today for the date of signing, form.place for the place of signing, form.user_name for the name of the person who fills the form in when the form asks for a contact at the office.',
  'Check boxes and radio groups that stand for a choice (legal form, yes/no) are linked to the source of that choice with the code that ticks them.',
  'Also say what the form is: its name in Dutch and English, the code printed on it, who it is about and whether it is about a period.',
].join(' ');

interface FormAnswer {
  name_nl: string;
  name_en: string;
  authority_code: string;
  subject: string;
  period: string;
  description_nl: string;
  description_en: string;
}

interface LinkAnswer {
  label: string;
  how: 'source' | 'compose' | 'fixed' | 'ask';
  source: string;
  template: string;
  value: string;
  format: string;
  tick_when: string;
  tick_value: string;
  required: boolean;
}

interface FieldsAnswer {
  form: FormAnswer;
  links: Array<LinkAnswer & { field: number; choices: Array<{ code: string; option: string }> }>;
}

interface BoxesAnswer {
  form: FormAnswer;
  boxes: Array<LinkAnswer & { page: number; area: string; x: number; y: number; width: number; height: number; kind: 'text' | 'checkbox'; cells: number; multiline: boolean }>;
}

const clip = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max);
const short = (box: PdfBox | null) => (box ? `x ${Math.round(box.x)}, y ${Math.round(box.y)}, w ${Math.round(box.width)}, h ${Math.round(box.height)}` : '–');

/**
 * Sets a newly uploaded PDF up with the AI, in the background: for a PDF with fields of its own, every field is linked to a value of the records (the words printed
 * next to it tell the AI what it is); for a PDF without fields, the AI says where on the page each answer goes — from the places to write the drawing of the page
 * shows (rectangles, letter boxes, tick boxes, lines) — and what goes in it. The AI also reads what the form is (its name, code, subject). Nothing is filled in for
 * a client here: the person checks the links (the screens show what the AI did) and every filled form is looked at before it is filed.
 */
@QueueProcessor()
@Injectable()
export class FormSetupService {
  private readonly logger = new Logger(FormSetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly pdf: PdfService,
    private readonly ai: AiService,
    private readonly sources: FormSourcesService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  private async save(versionId: string, setup: FormSetup, extra: Prisma.OfficialFormVersionUpdateInput = {}): Promise<void> {
    await this.prisma.officialFormVersion.update({ where: { id: versionId }, data: { ...extra, setup: setup as unknown as Prisma.InputJsonObject } });
  }

  /**
   * Starts the set-up of an edition when the AI may be used for it (the key, the switch of the feature); otherwise the edition is marked `off` and the person links or
   * places by hand. Returns the set-up as it is now.
   */
  async start(version: OfficialFormVersion, form: OfficialForm, options: { details?: boolean; replace?: boolean } = {}): Promise<FormSetup> {
    const current = readSetup(version.setup);
    const fields = readFields(version.fields);
    const setup: FormSetup = {
      ...current,
      mode: fields.some(field => !field.placed && isFillable(field)) ? 'fields' : 'flat',
      error: '',
      details: options.details ?? current.details,
      namesAtUpload: options.details ? { nl: form.nameNl, en: form.nameEn } : current.namesAtUpload,
      replace: options.replace === true,
    };
    // Nothing to do: every field is linked already (a new edition that kept its links), or the boxes of a PDF without fields came along from the edition before.
    const linked = new Set(readMapping(version.mapping).filter(entry => entry.source).map(entry => entry.pdfField));
    const open = setup.mode === 'fields' ? fields.filter(field => !field.placed && isFillable(field) && !linked.has(field.name)).length : setup.replace || !fields.some(field => field.placed) ? 1 : 0;
    if (!open && !setup.details) {
      setup.status = 'none';
      await this.save(version.id, setup);
      return setup;
    }
    if (!this.ai.isEnabled('form_setup')) {
      setup.status = 'off';
      await this.save(version.id, setup);
      return setup;
    }
    setup.status = 'waiting';
    await this.save(version.id, setup);
    try {
      await this.queue.send(QUEUE_FORM_SETUP, { versionId: version.id });
    } catch (error) {
      this.logger.warn(`The set-up of edition ${version.id} could not be queued: ${(error as Error).message}`);
      setup.status = 'failed';
      setup.error = 'queue_unavailable';
      await this.save(version.id, setup);
    }
    return setup;
  }

  @QueueWorker({ queue: QUEUE_FORM_SETUP, retryLimit: 1, retryDelaySeconds: 30, expireSeconds: 900, concurrency: 2 })
  async run(data: { versionId: string }, job: QueueJobContext): Promise<void> {
    const version = await this.prisma.officialFormVersion.findUnique({ where: { id: data.versionId }, include: { form: true } });
    if (!version) return;
    const setup = readSetup(version.setup);
    if (setup.status !== 'waiting' && setup.status !== 'running') return;
    await this.save(version.id, { ...setup, status: 'running' });
    try {
      const { buffer } = await this.files.bytes(version.fileId);
      const fields = readFields(version.fields);
      const flat = !fields.some(field => !field.placed && isFillable(field));
      const result = flat ? await this.placeBoxes(version, fields, buffer, setup, job.signal) : await this.linkFields(version, fields, buffer, job.signal);
      if (setup.details) await this.applyDetails(version.form, setup, result.form);
      await this.save(version.id, { ...setup, status: 'done', error: '', at: new Date().toISOString(), mode: flat ? 'flat' : 'fields', linked: result.linked, suggested: result.suggested, replace: false }, result.data);
      await this.audit.log({ action: 'updated', entityType: OFFICIAL_FORM_ENTITY, entityId: version.formId, entityLabel: version.form.nameNl, after: { edition: version.version, aiSetup: flat ? 'boxes' : 'links', linked: result.linked } });
    } catch (error) {
      if (error instanceof AiError) {
        this.logger.warn(`The AI set-up of edition ${version.id} failed: ${error.code}`);
        await this.save(version.id, { ...setup, status: 'failed', error: error.code, at: new Date().toISOString() });
        return;
      }
      this.logger.error(`The set-up of edition ${version.id} failed: ${(error as Error).message}`);
      if (!job.isLastAttempt) throw error;
      await this.save(version.id, { ...setup, status: 'failed', error: 'setup_failed', at: new Date().toISOString() });
    }
  }

  /* ── The list of sources the AI may use ───────────────────────────────────────────────────────────────────────── */

  private async catalogText(): Promise<{ text: string; known: Set<string> }> {
    const [dutch, english] = await Promise.all([this.sources.catalog('nl'), this.sources.catalog('en')]);
    const englishLabel = new Map(english.flatMap(group => group.entries.map(entry => [entry.key, entry.label])));
    const lines: string[] = [];
    for (const group of dutch) {
      for (const entry of group.entries) {
        const choices = entry.choices?.length ? ` [choices: ${entry.choices.map(choice => `${choice.code}=${choice.name}`).join(', ')}]` : '';
        lines.push(`${entry.key} — ${entry.label} / ${englishLabel.get(entry.key) ?? entry.label} (${entry.type})${choices}`);
      }
    }
    return { text: lines.join('\n'), known: await this.sources.knownKeys() };
  }

  private pageText(layout: readonly PdfPageLayout[], maxCharacters: number): string {
    let used = 0;
    const parts: string[] = [];
    for (const page of layout) {
      const text = page.lines.map(line => line.text).join('\n');
      if (used + text.length > maxCharacters) {
        parts.push(`--- page ${page.page + 1} ---\n${text.slice(0, Math.max(0, maxCharacters - used))}`);
        break;
      }
      parts.push(`--- page ${page.page + 1} ---\n${text}`);
      used += text.length;
    }
    return parts.join('\n');
  }

  /* ── A PDF with fields: link them ─────────────────────────────────────────────────────────────────────────────── */

  private async linkFields(version: OfficialFormVersion & { form: OfficialForm }, fields: PdfFieldInfo[], buffer: Buffer, signal: AbortSignal) {
    const layout = await this.pdf.layout(buffer, 20);
    const described = withContext(fields, layout);
    const fillable = described.filter(field => !field.placed && isFillable(field));
    const { text: catalog, known } = await this.catalogText();
    const list = fillable
      .map((field, index) =>
        [
          index + 1,
          field.kind,
          clip(field.name, 80),
          `page ${field.page + 1}`,
          field.tooltip ? `tooltip "${clip(field.tooltip, 120)}"` : '',
          field.context ? `next to it "${clip(field.context, 120)}"` : '',
          field.options.length ? `options: ${field.options.slice(0, 30).map(option => `"${clip(option, 40)}"`).join(', ')}` : '',
          field.maxLength ? `max ${field.maxLength} characters` : '',
        ]
          .filter(Boolean)
          .join(' | '),
      )
      .join('\n');
    const result = await this.ai.extract<FieldsAnswer>({
      feature: 'form_setup',
      tier: 'main',
      instructions: INSTRUCTIONS,
      text: [`Form file: ${version.fileName} (${version.pageCount} pages)`, `TEXT PRINTED ON THE FORM\n${this.pageText(layout, 14_000)}`, `FIELDS OF THE PDF (number | kind | name | page | …)\n${list}`, `SOURCES (key — Dutch name / English name (type) [choices code=name])\n${catalog}`].join('\n\n'),
      schemaName: 'form_fields',
      schema: FIELDS_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 24_000,
      userId: version.createdById,
      signal,
    });

    const current = readMapping(version.mapping);
    const linkedBefore = new Set(current.filter(entry => entry.source).map(entry => entry.pdfField));
    const proposed: FieldMapping[] = [];
    for (const link of result.data.links ?? []) {
      const field = fillable[link.field - 1];
      if (!field || linkedBefore.has(field.name)) continue;
      const entry = this.entryFor(field, link, known, link.choices);
      if (entry) proposed.push(entry);
    }
    // What a person linked before stays; the AI fills the fields nobody linked.
    const merged = [...current.filter(entry => entry.source || entry.label || entry.required), ...proposed.filter(entry => !current.some(existing => existing.pdfField === entry.pdfField && (existing.source || existing.label)))];
    const { mapping } = sanitizeMapping(merged, described, key => known.has(key));
    const suggested = proposed.filter(entry => mapping.some(saved => saved.pdfField === entry.pdfField && saved.source)).map(entry => entry.pdfField);
    return {
      form: result.data.form,
      linked: suggested.length,
      suggested,
      data: { fields: described as unknown as Prisma.InputJsonArray, mapping: mapping as unknown as Prisma.InputJsonArray },
    };
  }

  /* ── A PDF without fields: place the boxes ────────────────────────────────────────────────────────────────────── */

  private async placeBoxes(version: OfficialFormVersion & { form: OfficialForm }, fields: PdfFieldInfo[], buffer: Buffer, setup: FormSetup, signal: AbortSignal) {
    const layout = await this.pdf.layout(buffer, SETUP_MAX_PAGES);
    const { text: catalog, known } = await this.catalogText();
    const areas = new Map<string, { page: number; area: PdfArea }>();
    const pageParts = layout.map(page => {
      const lines = page.lines.map(line => `"${clip(line.text, 140)}" at ${short(line.box)}`).join('\n');
      const places = page.areas
        .map((area, index) => {
          const id = `p${page.page + 1}-a${index + 1}`;
          areas.set(id, { page: page.page, area });
          return `${id} ${area.kind}${area.kind === 'cells' ? ` (${area.cells} letter boxes)` : ''} at ${short(area.box)}`;
        })
        .join('\n');
      return `=== PAGE ${page.page + 1} (${Math.round(page.width)} × ${Math.round(page.height)} points) ===\nTEXT (with its place)\n${lines || '(no text: a scan — look at the picture of the page)'}\nPLACES TO WRITE\n${places || '(none found — give x, y, width and height yourself)'}`;
    });
    // The PDF goes along so the AI sees the pages; a very big or long PDF is described by its text only.
    const files: AiInputFile[] = buffer.length <= this.ai.maxFileBytes() && version.pageCount <= SETUP_MAX_PAGES ? [{ kind: 'pdf', mime: 'application/pdf', name: version.fileName, data: buffer, detail: 'high' }] : [];
    const result = await this.ai.extract<BoxesAnswer>({
      feature: 'form_setup',
      tier: 'main',
      instructions: [
        INSTRUCTIONS,
        'This PDF has no fields to fill in: the answers are written onto the page. Measures are in points from the top left corner of the page.',
        'For every answer choose the place to write from the list (its id) — a box, a row of letter boxes, a tick box or a line — next to or under its question. Only when no listed place fits, give the rectangle yourself.',
        'A row of letter boxes takes one character per box (cells = the number of boxes); a tick box is a checkbox.',
      ].join(' '),
      text: [`Form file: ${version.fileName} (${version.pageCount} pages)`, ...pageParts, `SOURCES (key — Dutch name / English name (type) [choices code=name])\n${catalog}`].join('\n\n'),
      files,
      schemaName: 'form_boxes',
      schema: BOXES_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 24_000,
      userId: version.createdById,
      signal,
    });

    const keep = setup.replace ? fields.filter(field => !field.placed) : fields;
    const keptMapping = setup.replace ? readMapping(version.mapping).filter(entry => keep.some(field => field.name === entry.pdfField)) : readMapping(version.mapping);
    const placed: PdfFieldInfo[] = [];
    const proposed: FieldMapping[] = [];
    const taken = new Set<string>();
    for (const answer of result.data.boxes ?? []) {
      const page = answer.page - 1;
      const size = setup.pages[page] ?? layout.find(entry => entry.page === page);
      if (!size || page < 0 || page >= version.pageCount) continue;
      const listed = answer.area ? areas.get(answer.area) : undefined;
      if (listed && taken.has(answer.area)) continue;
      const fromList = listed && listed.page === page ? listed.area : null;
      const box = fromList ? fromList.box : this.clamp({ x: answer.x, y: answer.y, width: answer.width, height: answer.height }, size);
      if (!box) continue;
      if (fromList) taken.add(answer.area);
      const kind = fromList?.kind === 'tick' ? 'checkbox' : answer.kind === 'checkbox' ? 'checkbox' : 'text';
      const cells = kind === 'text' ? (fromList?.kind === 'cells' ? fromList.cells : answer.cells > 1 ? answer.cells : null) : null;
      const name = nextBoxName([...keep, ...placed]);
      const field: PdfFieldInfo = { name, kind, page, options: [], maxLength: cells, multiline: kind === 'text' && !cells && answer.multiline, readOnly: false, tooltip: '', box, placed: true, cells, context: clip(answer.label, 160) };
      const entry = this.entryFor(field, answer, known, []);
      if (!entry) continue;
      placed.push(field);
      proposed.push(entry);
    }
    const pages = setup.pages.length ? setup.pages : layout.map(page => ({ width: page.width, height: page.height }));
    const { boxes } = sanitizeBoxes(placed, version.pageCount, pages);
    const all = [...keep, ...boxes];
    const { mapping } = sanitizeMapping([...keptMapping, ...proposed], all, key => known.has(key));
    const suggested = proposed.filter(entry => mapping.some(saved => saved.pdfField === entry.pdfField && saved.source)).map(entry => entry.pdfField);
    return {
      form: result.data.form,
      linked: suggested.length,
      suggested,
      data: { fields: all as unknown as Prisma.InputJsonArray, mapping: mapping as unknown as Prisma.InputJsonArray },
    };
  }

  /** A rectangle the AI gave, kept on the page; null when it makes no sense. */
  private clamp(box: PdfBox, page: { width: number; height: number }): PdfBox | null {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 4 || box.height < 4) return null;
    const x = Math.min(Math.max(0, box.x), page.width - 4);
    const y = Math.min(Math.max(0, box.y), page.height - 4);
    return { x, y, width: Math.min(box.width, page.width - x), height: Math.min(box.height, page.height - y) };
  }

  /* ── One answer of the AI as an entry of the mapping ──────────────────────────────────────────────────────────── */

  private entryFor(field: PdfFieldInfo, link: LinkAnswer, known: Set<string>, choices: Array<{ code: string; option: string }>): FieldMapping | null {
    let source: SourceRef | null = null;
    if (link.how === 'source' && known.has(link.source)) source = { type: 'field', key: link.source };
    else if (link.how === 'compose' && link.template && placeholdersOf(link.template).length && placeholdersOf(link.template).every(key => known.has(key))) source = { type: 'compose', template: clip(link.template, 500) };
    else if (link.how === 'fixed' && link.value.trim()) source = { type: 'fixed', value: clip(link.value, 500) };
    else if (link.how === 'ask') source = { type: 'ask' };
    // A check box needs the value it looks at; a radio group or a drop-down a value to choose by.
    if (field.kind === 'checkbox' && source?.type !== 'field' && source?.type !== 'ask') source = link.source && known.has(link.source) ? { type: 'field', key: link.source } : null;
    if (!source) return null;

    const entry: FieldMapping = { ...emptyMapping(field.name), label: clip(link.label, 160), source, required: link.required === true };
    if (field.kind === 'text') entry.format = (TEXT_FORMATS as readonly string[]).includes(link.format) ? (link.format as TextFormat) : 'as_is';
    if (field.kind === 'checkbox' && source.type === 'field') {
      const op = (TEST_OPS as readonly string[]).includes(link.tick_when) && link.tick_when !== 'in' ? (link.tick_when as TestOp) : 'truthy';
      entry.test = op === 'eq' || op === 'ne' ? (link.tick_value ? { op, value: clip(link.tick_value, 120) } : { op: 'truthy' }) : { op };
    }
    if ((field.kind === 'radio' || field.kind === 'dropdown' || field.kind === 'list') && source.type === 'field') {
      const options = new Map(field.options.map(option => [option.trim().toLowerCase(), option]));
      entry.choices = choices.flatMap(choice => {
        const option = options.get(choice.option.trim().toLowerCase());
        return option && choice.code ? [{ when: { op: 'eq' as const, value: clip(choice.code, 120) }, option }] : [];
      });
    }
    return entry;
  }

  /* ── What the form is ─────────────────────────────────────────────────────────────────────────────────────────── */

  /** The name, code, description, subject and period the AI read — only while the form still has the names it got when its PDF was uploaded (nobody renamed it since). */
  private async applyDetails(form: OfficialForm, setup: FormSetup, answer: FormAnswer | undefined): Promise<void> {
    if (!answer || !setup.namesAtUpload) return;
    const fresh = await this.prisma.officialForm.findUnique({ where: { id: form.id } });
    if (!fresh || fresh.nameNl !== setup.namesAtUpload.nl || fresh.nameEn !== setup.namesAtUpload.en) return;
    const data: Prisma.OfficialFormUpdateInput = {};
    const nameNl = clip(answer.name_nl, 120);
    const nameEn = clip(answer.name_en, 120);
    if (nameNl) data.nameNl = nameNl;
    if (nameEn) data.nameEn = nameEn;
    if (!fresh.authorityCode && clip(answer.authority_code, 60)) data.authorityCode = clip(answer.authority_code, 60);
    if (!fresh.descriptionNl && clip(answer.description_nl, 1000)) data.descriptionNl = clip(answer.description_nl, 1000);
    if (!fresh.descriptionEn && clip(answer.description_en, 1000)) data.descriptionEn = clip(answer.description_en, 1000);
    if ((SUBJECTS as readonly string[]).includes(answer.subject)) data.subject = answer.subject;
    if ((PERIOD_KINDS as readonly string[]).includes(answer.period)) data.periodKind = answer.period;
    if (!Object.keys(data).length) return;
    await this.prisma.officialForm.update({ where: { id: form.id }, data });
    await this.audit.log({ action: 'updated', entityType: OFFICIAL_FORM_ENTITY, entityId: form.id, entityLabel: String(data.nameNl ?? fresh.nameNl), before: { nameNl: fresh.nameNl, nameEn: fresh.nameEn }, after: { ...data, by: 'ai' } as Record<string, unknown> });
  }
}
