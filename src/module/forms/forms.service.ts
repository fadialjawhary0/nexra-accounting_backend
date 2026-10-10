import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { docFor } from './field-access.js';
import { checkDoc } from './form-doc-checker.js';
import { emptyDoc, type FormDoc } from './form-doc.js';
import { FORM_ENTITIES, FORM_ENTITY_KEYS, type FormEntity } from './form-entities.js';

const CACHE_MS = 30_000;

const asDoc = (value: Prisma.JsonValue | null | undefined): FormDoc => (value && typeof value === 'object' && !Array.isArray(value) ? (value as unknown as FormDoc) : emptyDoc());
const toJson = (doc: FormDoc): Prisma.InputJsonValue => JSON.parse(JSON.stringify(doc)) as Prisma.InputJsonValue;

const describeEntity = (entity: string, config: FormEntity) => ({ entity, names: config.names, description: config.description, area: config.area });

/**
 * The form definitions: one live document per kind of record, a draft the form builder works on, and a snapshot of every
 * publication. Other modules read the live document (and validate record values against it with FormValidationService).
 */
@Injectable()
export class FormsService {
  private readonly cache = new Map<string, { doc: FormDoc; revision: number; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The entity's configuration, or 404. */
  config(entity: string): FormEntity {
    const config = FORM_ENTITIES[entity];
    if (!config) throw new NotFoundException({ code: 'not_found', message: 'Unknown form' });
    return config;
  }

  /** The published document (cached for a short while; publishing refreshes it). */
  async live(entity: string): Promise<{ doc: FormDoc; revision: number }> {
    this.config(entity);
    const hit = this.cache.get(entity);
    if (hit && Date.now() - hit.at < CACHE_MS) return { doc: hit.doc, revision: hit.revision };
    const row = await this.prisma.formDefinition.findUnique({ where: { entity }, select: { live: true, revision: true } });
    const loaded = { doc: asDoc(row?.live), revision: row?.revision ?? 0, at: Date.now() };
    this.cache.set(entity, loaded);
    return { doc: loaded.doc, revision: loaded.revision };
  }

  /** The published form as this person gets it to fill in (fields they may not see left out). Needs `view` on the entity's area. */
  async liveFor(entity: string, user: AuthenticatedUser) {
    const config = this.config(entity);
    if (!matrixAllows(user.matrix, `${config.area}.view`)) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
    const { doc, revision } = await this.live(entity);
    return { entity, revision, area: config.area, doc: docFor(doc, user.matrix) };
  }

  /** Settings → Forms: every form with its state. */
  async overview() {
    const rows = new Map((await this.prisma.formDefinition.findMany({ select: { entity: true, live: true, draft: true, revision: true, publishedAt: true } })).map(row => [row.entity, row]));
    return FORM_ENTITY_KEYS.map(entity => {
      const row = rows.get(entity);
      const doc = asDoc(row?.live);
      return {
        ...describeEntity(entity, FORM_ENTITIES[entity]!),
        revision: row?.revision ?? 0,
        publishedAt: row?.publishedAt.toISOString() ?? null,
        hasDraft: Boolean(row?.draft),
        fieldCount: doc.fields.length,
        activeCount: doc.fields.filter(field => field.active).length,
        customCount: doc.fields.filter(field => field.kind === 'custom').length,
      };
    });
  }

  /** Everything the form builder needs for one form: the live document and the draft (null when nothing is pending). */
  async builder(entity: string) {
    const config = this.config(entity);
    const row = await this.prisma.formDefinition.findUnique({ where: { entity } });
    return {
      ...describeEntity(entity, config),
      revision: row?.revision ?? 0,
      publishedAt: row?.publishedAt.toISOString() ?? null,
      live: asDoc(row?.live),
      draft: row?.draft ? asDoc(row.draft) : null,
      draftUpdatedAt: row?.draftUpdatedAt?.toISOString() ?? null,
    };
  }

  /** The document the builder is working on (the draft, or the live one when there is no draft), checked and cleaned. */
  async workingDoc(entity: string): Promise<FormDoc> {
    const { draft, live } = await this.builder(entity);
    return checkDoc(draft ?? live, live, await this.knownLists()).doc;
  }

  /** Saves the builder's working copy. Nothing changes for the people filling in forms until it is published. */
  async saveDraft(entity: string, input: unknown, user: AuthenticatedUser) {
    this.config(entity);
    const current = await this.prisma.formDefinition.findUnique({ where: { entity } });
    const { doc, problems } = checkDoc(input, current ? asDoc(current.live) : null, await this.knownLists());
    if (Object.keys(problems).length) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: problems });
    const draftUpdatedAt = new Date();
    if (current) {
      await this.prisma.formDefinition.update({ where: { entity }, data: { draft: toJson(doc), draftUpdatedAt, draftUpdatedById: user.id } });
    } else {
      // A form nobody has published yet (first use): the draft is created together with an empty live document.
      await this.prisma.formDefinition.create({ data: { entity, live: toJson(emptyDoc()), revision: 0, draft: toJson(doc), draftUpdatedAt, draftUpdatedById: user.id } });
    }
    return this.builder(entity);
  }

  async discardDraft(entity: string) {
    this.config(entity);
    await this.prisma.formDefinition.updateMany({ where: { entity }, data: { draft: Prisma.DbNull, draftUpdatedAt: null, draftUpdatedById: null } });
    return this.builder(entity);
  }

  /** Makes the draft the live form: a new revision, kept as a snapshot. */
  async publish(entity: string, note: string, user: AuthenticatedUser) {
    const config = this.config(entity);
    const row = await this.prisma.formDefinition.findUnique({ where: { entity } });
    if (!row?.draft) throw new ConflictException({ code: 'nothing_to_publish', message: 'There are no changes to publish.' });
    const { doc, problems } = checkDoc(row.draft, asDoc(row.live), await this.knownLists());
    if (Object.keys(problems).length) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: problems });

    const revision = row.revision + 1;
    await this.prisma.$transaction([
      this.prisma.formRevision.create({ data: { entity, revision, doc: toJson(doc), note: note.slice(0, 300), publishedById: user.id } }),
      this.prisma.formDefinition.update({
        where: { entity },
        data: { live: toJson(doc), revision, publishedAt: new Date(), publishedById: user.id, draft: Prisma.DbNull, draftUpdatedAt: null, draftUpdatedById: null },
      }),
    ]);
    this.cache.delete(entity);
    await this.audit.log({
      action: 'updated',
      entityType: 'form',
      entityId: entity,
      entityLabel: config.names.en,
      meta: { revision, fields: doc.fields.length, note: note || undefined },
    });
    return this.builder(entity);
  }

  async revisions(entity: string) {
    this.config(entity);
    const rows = await this.prisma.formRevision.findMany({ where: { entity }, orderBy: { revision: 'desc' }, take: 50 });
    return rows.map(row => ({ revision: row.revision, publishedAt: row.publishedAt.toISOString(), publishedById: row.publishedById, note: row.note, fieldCount: asDoc(row.doc).fields.length }));
  }

  /** Puts an earlier revision back into the draft (fields added since stay, hidden — a published field can never disappear). */
  async restore(entity: string, revision: number, user: AuthenticatedUser) {
    this.config(entity);
    const [old, current] = await Promise.all([this.prisma.formRevision.findUnique({ where: { entity_revision: { entity, revision } } }), this.prisma.formDefinition.findUnique({ where: { entity } })]);
    if (!old || !current) throw new NotFoundException({ code: 'not_found', message: 'Revision not found' });
    const doc = asDoc(old.doc);
    const live = asDoc(current.live);
    const have = new Set(doc.fields.map(field => field.key));
    const sectionKeys = new Set(doc.sections.map(section => section.key));
    for (const section of live.sections) if (!sectionKeys.has(section.key) && live.fields.some(field => field.section === section.key && !have.has(field.key))) doc.sections.push(section);
    for (const field of live.fields) if (!have.has(field.key)) doc.fields.push({ ...field, active: field.locked, showWhen: field.showWhen });
    return this.saveDraft(entity, doc, user);
  }

  private async knownLists(): Promise<Set<string>> {
    return new Set((await this.prisma.list.findMany({ select: { key: true } })).map(list => list.key));
  }
}
