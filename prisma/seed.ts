import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { fold } from '../src/common/text.js';
import { scanTemplate } from '../src/lib/documents/docx-template.js';
import { PdfService } from '../src/lib/pdf/pdf.service.js';
import { CONTRACT_REMINDER_DEFAULTS, CONTRACT_REMINDER_NAMES } from '../src/module/contracts/contract-reminder-defaults.js';
import { DOCUMENT_REMINDER_DEFAULTS, DOCUMENT_REMINDER_NAMES } from '../src/module/documents/document-reminder-defaults.js';
import type { FormDoc } from '../src/module/forms/form-doc.js';
import { sanitizeMapping } from '../src/module/official-forms/form-mapping.js';
import { FORM_FOLLOW_UP_DEFAULTS, FORM_FOLLOW_UP_NAME, FORM_FOLLOW_UP_TRIGGER } from '../src/module/official-forms/official-forms.constants.js';
import { sanitizeDoc as sanitizeChecklist } from '../src/module/inspections/checklist-doc.js';
import { INSPECTION_REMINDER_DEFAULTS, INSPECTION_REMINDER_NAMES } from '../src/module/inspections/inspections.constants.js';
import { TAX_REMINDER_DEFAULTS, TAX_REMINDER_NAMES } from '../src/module/taxes/taxes.constants.js';
import { INVOICE_DUE_TRIGGER, INVOICE_REMINDER_DEFAULTS, INVOICE_REMINDER_NAME } from '../src/module/invoices/invoices.constants.js';
import { TASK_DUE_TRIGGER, TASK_REMINDER_DEFAULTS, TASK_REMINDER_NAME } from '../src/module/tasks/tasks.constants.js';
import { SEED_CHECKLISTS } from './seed-data/checklists.js';
import { buildSampleForm } from './seed-data/official-form-pdfs.js';
import { SEED_ADDRESSES, SEED_FORMS as SEED_OFFICIAL_FORMS, mappingOf, sampleOf } from './seed-data/official-forms.js';
import { SEED_DOCUMENT_TYPES, SEED_FOLDERS, SEED_REQUIRED_DOCUMENTS, SYSTEM_TYPE_CODES } from './seed-data/documents.js';
import { SEED_EXPORT_PRESETS } from './seed-data/export-presets.js';
import { SEED_FORMS } from './seed-data/forms.js';
import { SEED_MAPPINGS } from './seed-data/import-mappings.js';
import { SEED_LISTS } from './seed-data/lists.js';
import { SEED_MESSAGES } from './seed-data/messages.js';
import { SEED_SURCHARGE_RULES } from './seed-data/surcharges.js';
import { SEED_VAT_STEPS } from './seed-data/taxes.js';
import { STARTER_TEMPLATES, buildStarterDocx } from './seed-data/templates.js';
import { normalizeHeader } from '../src/module/imports/sheet-mapping.js';
import { MEDEWERKER_PERMISSIONS, MEDEWERKER_ROLE_KEY, OWNER_ROLE_KEY, fullAccess } from '../src/module/roles/permission-catalog.js';

/**
 * Reference data every environment needs: roles and the owner account (Phase 4), settings, pick-lists and the status /
 * type lookup tables with their Dutch + English names, Dutch holidays, … (Phase 5 onwards).
 * Idempotent — running it twice changes nothing (use upsert on a natural key). Never put real client data here.
 * Each phase adds its seeder to the list.
 */
interface Seeder {
  name: string;
  run: (prisma: PrismaClient) => Promise<void>;
}

const seeders: Seeder[] = [
  {
    name: 'roles',
    run: async prisma => {
      // The owner keeps full access whatever is stored; the staff role is only created — Ahmad's later edits are never overwritten.
      await prisma.role.upsert({
        where: { key: OWNER_ROLE_KEY },
        create: { key: OWNER_ROLE_KEY, name: 'Owner', description: 'Full access to everything, including users, roles and security settings. Cannot be removed.', isSystem: true, permissions: fullAccess() },
        update: { isSystem: true, permissions: fullAccess() },
      });
      await prisma.role.upsert({
        where: { key: MEDEWERKER_ROLE_KEY },
        create: { key: MEDEWERKER_ROLE_KEY, name: 'Medewerker', description: 'Staff member: works with clients, tasks and the calendar. Cannot manage users or settings.', isSystem: true, permissions: MEDEWERKER_PERMISSIONS },
        update: {},
      });
    },
  },
  {
    name: 'lists',
    run: async prisma => {
      // Only creates what is missing: renames, reordering and switched-off items made by the office are never overwritten.
      for (const seed of SEED_LISTS) {
        const list = await prisma.list.upsert({
          where: { key: seed.key },
          create: {
            key: seed.key,
            nameNl: seed.nameNl,
            nameEn: seed.nameEn,
            descriptionNl: seed.descriptionNl ?? '',
            descriptionEn: seed.descriptionEn ?? '',
            kind: seed.kind ?? 'picklist',
            isSystem: true,
            allowNewItems: seed.allowNewItems ?? true,
          },
          update: {},
        });
        await prisma.listItem.createMany({
          data: seed.items.map(([code, nameNl, nameEn, meta], index) => ({ listId: list.id, code, nameNl, nameEn, sortOrder: (index + 1) * 10, isSystem: true, meta: meta ?? {} })),
          skipDuplicates: true,
        });
      }
    },
  },
  {
    name: 'forms',
    run: async prisma => {
      // A form that does not exist yet is created. One that does belongs to the office (the form builder renames, hides and adds
      // fields): the seed never overwrites it, it only adds system fields a newer version of the system introduced (where the seed has
      // them), and makes the one-time changes of FORM_CHANGES the office asked for.
      for (const [entity, doc] of Object.entries(SEED_FORMS)) {
        const existing = await prisma.formDefinition.findUnique({ where: { entity } });
        if (!existing) {
          const json = JSON.parse(JSON.stringify(doc)) as object;
          // A new form has the one-time changes in it already: their marks go in the note, so they never run on it.
          const note = ['First version', ...FORM_CHANGES.filter(change => change.entity === entity).map(change => `[${change.id}]`)].join(' ');
          await prisma.formDefinition.create({ data: { entity, live: json, revision: 1, revisions: { create: { revision: 1, doc: json, note } } } });
          continue;
        }
        const live = existing.live as unknown as FormDoc;
        const added = doc.fields.filter(field => !live.fields.some(have => have.key === field.key));
        if (!added.length) continue;
        const draft = existing.draft as unknown as FormDoc | null;
        const next = appendFields(live, doc, added);
        const nextDraft = draft ? appendFields(draft, doc, added) : null;
        const revision = existing.revision + 1;
        const json = JSON.parse(JSON.stringify(next)) as object;
        await prisma.$transaction([
          prisma.formRevision.create({ data: { entity, revision, doc: json, note: `System update: added ${added.map(field => field.key).join(', ')}` } }),
          prisma.formDefinition.update({
            where: { entity },
            data: { live: json, revision, publishedAt: new Date(), ...(nextDraft && { draft: JSON.parse(JSON.stringify(nextDraft)) as object }) },
          }),
        ]);
        console.log(`  ${entity}: added ${added.map(field => field.key).join(', ')} (revision ${revision}).`);
      }

      for (const change of FORM_CHANGES) {
        const existing = await prisma.formDefinition.findUnique({ where: { entity: change.entity } });
        if (!existing) continue;
        const mark = `[${change.id}]`;
        if (await prisma.formRevision.findFirst({ where: { entity: change.entity, note: { contains: mark } } })) continue;
        const live = change.apply(existing.live as unknown as FormDoc);
        if (!live) continue;
        const draft = existing.draft ? change.apply(existing.draft as unknown as FormDoc) : null;
        const revision = existing.revision + 1;
        const json = JSON.parse(JSON.stringify(live)) as object;
        await prisma.$transaction([
          prisma.formRevision.create({ data: { entity: change.entity, revision, doc: json, note: `System update ${mark}: ${change.note}` } }),
          prisma.formDefinition.update({
            where: { entity: change.entity },
            data: { live: json, revision, publishedAt: new Date(), ...(draft && { draft: JSON.parse(JSON.stringify(draft)) as object }) },
          }),
        ]);
        console.log(`  ${change.entity}: ${change.note} (revision ${revision}).`);
      }
    },
  },
  {
    name: 'starter templates',
    run: async prisma => {
      // Example Word templates (synthetic text), made once. The office uploads its own file as a new version; a template that exists is never touched — except a
      // starter template nobody replaced that still uses merge fields the system no longer has (the contract form's holiday and collective-agreement fields,
      // removed 17-10-2026): it gets the current example as a new version.
      const root = path.resolve(process.env.STORAGE_DIR?.trim() || './storage');
      const RETIRED_TAGS = new Set(['contract.cao', 'contract.vacation_hours_per_hour', 'contract.vacation_days_per_year']);
      const store = async (spec: (typeof STARTER_TEMPLATES)[number]) => {
        const bytes = await buildStarterDocx(spec);
        const key = `files/${randomUUID()}`;
        const target = path.join(root, ...key.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
        const file = await prisma.storedFile.create({
          data: {
            name: `${spec.name}.docx`,
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            storageKey: key,
            purpose: 'template',
            area: 'templates',
            entityType: 'template',
          },
        });
        return { file, tags: scanTemplate(bytes) };
      };
      for (const spec of STARTER_TEMPLATES) {
        const existing = await prisma.template.findUnique({ where: { code: spec.code }, include: { versions: { orderBy: { version: 'desc' } } } });
        if (existing) {
          const latest = existing.versions[0];
          const retired = (Array.isArray(latest?.tags) ? (latest.tags as Array<{ tag?: unknown }>) : []).some(entry => typeof entry?.tag === 'string' && RETIRED_TAGS.has(entry.tag));
          if (!latest || !retired || existing.versions.some(version => version.createdById)) continue;
          const { file, tags } = await store(spec);
          await prisma.templateVersion.create({
            data: { templateId: existing.id, version: latest.version + 1, fileId: file.id, fileName: file.name, tags: tags as unknown as Prisma.InputJsonValue, note: 'Voorbeeld bijgewerkt door het systeem: zonder de vervallen contractvelden voor vakantie en cao' },
          });
          await prisma.storedFile.update({ where: { id: file.id }, data: { entityId: existing.id } });
          console.log(`  Updated the starter template "${spec.name}" (version ${latest.version + 1}).`);
          continue;
        }
        const { file, tags } = await store(spec);
        const template = await prisma.template.create({
          data: { code: spec.code, name: spec.name, kind: spec.kind, scope: 'office', language: 'nl', contractType: spec.contractType, description: spec.description },
        });
        await prisma.templateVersion.create({
          data: { templateId: template.id, version: 1, fileId: file.id, fileName: file.name, tags: tags as unknown as Prisma.InputJsonValue, note: 'Voorbeeld dat met het systeem wordt meegeleverd' },
        });
        await prisma.storedFile.update({ where: { id: file.id }, data: { entityId: template.id } });
        console.log(`  Created the starter template "${spec.name}".`);
      }
    },
  },
  {
    name: 'WhatsApp messages',
    run: async prisma => {
      // Created once; edits made by the office are never overwritten.
      for (const [index, message] of SEED_MESSAGES.entries()) {
        await prisma.messageTemplate.upsert({
          where: { code: message.code },
          create: { code: message.code, name: message.name, channel: 'whatsapp', scope: 'contract', audience: message.audience, bodyNl: message.bodyNl, bodyEn: message.bodyEn, sortOrder: (index + 1) * 10 },
          update: {},
        });
      }
    },
  },
  {
    name: 'folder template',
    run: async prisma => {
      // The standard folders of a client. Created once; renames, the order and switched-off folders made by the office are never overwritten.
      await prisma.folderTemplate.createMany({
        data: SEED_FOLDERS.map((folder, index) => ({ code: folder.code, nameNl: folder.nameNl, nameEn: folder.nameEn, sortOrder: (index + 1) * 10, isSystem: true })),
        skipDuplicates: true,
      });
    },
  },
  {
    name: 'document types',
    run: async prisma => {
      // The types with their valid-until rules, naming patterns and standard folders. Created once; the office's edits are never overwritten.
      await prisma.documentType.createMany({
        data: SEED_DOCUMENT_TYPES.map((type, index) => ({
          code: type.code,
          nameNl: type.nameNl,
          nameEn: type.nameEn,
          scope: type.scope,
          validity: type.validity,
          validityMonths: type.validityMonths ?? null,
          validityField: type.validityField ?? null,
          warnDays: type.warnDays ?? null,
          versioned: type.versioned ?? false,
          personal: type.personal ?? false,
          folderCode: type.folderCode ?? null,
          namePattern: type.namePattern ?? '',
          keywords: type.keywords ?? '',
          sortOrder: (index + 1) * 10,
          isSystem: SYSTEM_TYPE_CODES.has(type.code),
        })),
        skipDuplicates: true,
      });
    },
  },
  {
    name: 'required documents',
    run: async prisma => {
      // Only when the office has no rules at all (once there are some, they belong to the office).
      if (await prisma.requiredDocument.count()) return;
      for (const [index, rule] of SEED_REQUIRED_DOCUMENTS.entries()) {
        await prisma.requiredDocument.create({
          data: { typeCode: rule.typeCode, scope: rule.scope, condition: (rule.condition as Prisma.InputJsonObject | undefined) ?? Prisma.DbNull, note: rule.note, sortOrder: (index + 1) * 10 },
        });
      }
    },
  },
  {
    name: 'address book',
    run: async prisma => {
      // The addresses the example forms are sent to. Created once (found by name, postal code, box and department); the office's edits are never overwritten.
      for (const [index, entry] of SEED_ADDRESSES.entries()) {
        const identity = { name: entry.name, postalCode: entry.postalCode, box: entry.box ?? '', department: entry.department ?? '' };
        if (await prisma.addressBookEntry.findFirst({ where: identity })) continue;
        const pieces = [entry.name, entry.department ?? '', entry.box ?? '', entry.postalCode, entry.postalCode.replace(/\s+/g, ''), entry.city, entry.note];
        await prisma.addressBookEntry.create({
          data: { ...identity, boxKind: entry.boxKind ?? 'po_box', city: entry.city, country: 'NL', category: entry.category, note: entry.note, sortOrder: (index + 1) * 10, searchText: [...new Set(pieces.map(fold).filter(Boolean))].join(' ') },
        });
      }
    },
  },
  {
    name: 'official forms',
    run: async prisma => {
      // Example forms (made-up fillable PDFs with their mapping), made once. The office uploads the official PDF as a new edition; a form that exists is never touched.
      // The PDF reading is done by the same class the app uses, made here by hand because the seed runs outside the app.
      const pdf = new PdfService();
      const root = path.resolve(process.env.STORAGE_DIR?.trim() || './storage');
      for (const [index, spec] of SEED_OFFICIAL_FORMS.entries()) {
        if (await prisma.officialForm.findUnique({ where: { code: spec.code } })) continue;
        const bytes = await buildSampleForm(sampleOf(spec));
        const info = await pdf.inspect(bytes);
        const { mapping, problems } = sanitizeMapping(mappingOf(spec), info.fields, () => true);
        if (Object.keys(problems).length) throw new Error(`The mapping of the example form ${spec.code} does not fit its PDF: ${JSON.stringify(problems)}`);

        const address = spec.recipient ? SEED_ADDRESSES.find(entry => entry.key === spec.recipient) : null;
        const recipient = address ? await prisma.addressBookEntry.findFirst({ where: { name: address.name, postalCode: address.postalCode, box: address.box ?? '', department: address.department ?? '' } }) : null;
        const key = `files/${randomUUID()}`;
        const target = path.join(root, ...key.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
        const fileName = `${spec.nameNl.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()} (voorbeeld).pdf`;
        const file = await prisma.storedFile.create({
          data: { name: fileName, mimeType: 'application/pdf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), storageKey: key, purpose: 'form_blank', area: 'official_forms', entityType: 'official_form' },
        });
        const form = await prisma.officialForm.create({
          data: {
            code: spec.code,
            nameNl: spec.nameNl,
            nameEn: spec.nameEn,
            descriptionNl: spec.descriptionNl,
            descriptionEn: spec.descriptionEn,
            authorityCode: spec.authorityCode,
            officialUrl: spec.officialUrl,
            subject: spec.subject,
            periodKind: spec.periodKind,
            recipientId: recipient?.id ?? null,
            followUpDays: spec.followUpDays,
            warnWhenPending: spec.warnWhenPending,
            docType: 'form',
            folderCode: spec.folderCode,
            sortOrder: (index + 1) * 10,
          },
        });
        await prisma.officialFormVersion.create({
          data: {
            formId: form.id,
            version: 1,
            fileId: file.id,
            fileName: file.name,
            pageCount: info.pageCount,
            fields: info.fields as unknown as Prisma.InputJsonArray,
            mapping: mapping as unknown as Prisma.InputJsonArray,
            isSample: true,
            note: 'Voorbeeld dat met het systeem wordt meegeleverd',
          },
        });
        await prisma.storedFile.update({ where: { id: file.id }, data: { entityId: form.id } });
        console.log(`  Created the example form "${spec.nameNl}".`);
      }
    },
  },
  {
    name: 'inspection checklists',
    run: async prisma => {
      // The checklist of what a NEN 4400-1 inspector asks for, as its first edition (published). Created once; the office edits it (a change is a new edition). A checklist
      // that exists is only touched when its newest edition is still one the system shipped (`replaces`, published by nobody): the newer shipped edition is then added
      // on top — inspections prepared with the older one keep it. An edition of the office's own is never touched.
      for (const [index, spec] of SEED_CHECKLISTS.entries()) {
        const existing = await prisma.checklistTemplate.findUnique({ where: { code: spec.code }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
        if (existing && spec.replacesDescription && existing.descriptionNl === spec.replacesDescription.nl && existing.descriptionEn === spec.replacesDescription.en) {
          await prisma.checklistTemplate.update({ where: { id: existing.id }, data: { descriptionNl: spec.descriptionNl, descriptionEn: spec.descriptionEn } });
          console.log(`  Updated the description of the checklist "${existing.nameNl}".`);
        }
        const newest = existing?.versions[0];
        if (existing && !(newest && newest.status === 'published' && !newest.publishedById && !newest.createdById && (spec.replaces ?? []).includes(newest.label))) continue;
        const { doc, problems } = sanitizeChecklist({ sections: spec.version.sections, items: spec.version.items }, {
          types: new Set((await prisma.documentType.findMany({ select: { code: true } })).map(type => type.code)),
          // The fields a condition may look at: the seeded client form's own.
          fields: new Set(((SEED_FORMS.client?.fields ?? []) as Array<{ key: string }>).map(field => `client.${field.key}`)),
        });
        if (Object.keys(problems).length) throw new Error(`The seeded checklist ${spec.code} is not valid: ${JSON.stringify(problems)}`);
        if (existing && newest) {
          await prisma.checklistVersion.create({
            data: {
              templateId: existing.id,
              version: newest.version + 1,
              label: spec.version.label,
              note: spec.version.note,
              status: 'published',
              publishedAt: new Date(),
              sections: doc.sections as unknown as Prisma.InputJsonArray,
              items: doc.items as unknown as Prisma.InputJsonArray,
            },
          });
          console.log(`  Added edition ${newest.version + 1} of the checklist "${existing.nameNl}" (${doc.items.length} lines).`);
          continue;
        }
        await prisma.checklistTemplate.create({
          data: {
            code: spec.code,
            nameNl: spec.nameNl,
            nameEn: spec.nameEn,
            descriptionNl: spec.descriptionNl,
            descriptionEn: spec.descriptionEn,
            inspectionTypes: spec.inspectionTypes,
            sortOrder: (index + 1) * 10,
            versions: {
              create: {
                version: 1,
                label: spec.version.label,
                note: spec.version.note,
                status: 'published',
                publishedAt: new Date(),
                sections: doc.sections as unknown as Prisma.InputJsonArray,
                items: doc.items as unknown as Prisma.InputJsonArray,
              },
            },
          },
        });
        console.log(`  Created the checklist "${spec.nameNl}" with ${doc.items.length} lines.`);
      }
    },
  },
  {
    name: 'VAT steps',
    run: async prisma => {
      // The six steps of the office's quarter sheet. A step that exists belongs to the office (renamed, reordered, switched off …): the seed only adds the ones that are missing.
      for (const [index, step] of SEED_VAT_STEPS.entries()) {
        await prisma.vatStep.upsert({
          where: { code: step.code },
          create: { code: step.code, nameNl: step.nameNl, nameEn: step.nameEn, groupNl: step.groupNl, groupEn: step.groupEn, isFiling: step.isFiling ?? false, sortOrder: (index + 1) * 10 },
          update: {},
        });
      }
    },
  },
  {
    name: 'reminder rules',
    run: async prisma => {
      // One rule per trigger to start with (Ahmad: contract end 30 + 14 days, IDs two months ahead …); once there is one, the office owns the rules.
      const rules = [
        ...Object.entries(CONTRACT_REMINDER_DEFAULTS).map(([trigger, defaults]) => ({ trigger, name: CONTRACT_REMINDER_NAMES[trigger as keyof typeof CONTRACT_REMINDER_NAMES], active: true, ...defaults })),
        ...Object.entries(DOCUMENT_REMINDER_DEFAULTS).map(([trigger, defaults]) => ({ trigger, name: DOCUMENT_REMINDER_NAMES[trigger as keyof typeof DOCUMENT_REMINDER_NAMES], ...defaults })),
        { trigger: FORM_FOLLOW_UP_TRIGGER, name: FORM_FOLLOW_UP_NAME, ...FORM_FOLLOW_UP_DEFAULTS },
        ...Object.entries(INSPECTION_REMINDER_DEFAULTS).map(([trigger, defaults]) => ({ trigger, name: INSPECTION_REMINDER_NAMES[trigger as keyof typeof INSPECTION_REMINDER_NAMES], ...defaults })),
        ...Object.entries(TAX_REMINDER_DEFAULTS).map(([trigger, defaults]) => ({ trigger, name: TAX_REMINDER_NAMES[trigger as keyof typeof TAX_REMINDER_NAMES], ...defaults })),
        { trigger: INVOICE_DUE_TRIGGER, name: INVOICE_REMINDER_NAME, ...INVOICE_REMINDER_DEFAULTS },
        // A task's reminder goes to the person the task is assigned to, not to the owner role (that would be every task of everybody).
        { trigger: TASK_DUE_TRIGGER, name: TASK_REMINDER_NAME, ...TASK_REMINDER_DEFAULTS, ownerRole: false },
      ];
      for (const rule of rules) {
        if (await prisma.reminderRule.count({ where: { trigger: rule.trigger } })) continue;
        await prisma.reminderRule.create({
          data: {
            trigger: rule.trigger,
            name: rule.name,
            isActive: rule.active,
            offsets: [...rule.offsets],
            dayType: rule.dayType,
            recipients: { roles: 'ownerRole' in rule && rule.ownerRole === false ? [] : [OWNER_ROLE_KEY], users: [], responsible: true },
            channels: [...rule.channels],
          },
        });
      }
    },
  },
  {
    name: 'surcharge rules',
    run: async prisma => {
      // Examples, all switched off — only when there are no rules at all (once the office has its own, they are never touched).
      if (await prisma.surchargeRule.count()) return;
      for (const [index, rule] of SEED_SURCHARGE_RULES.entries()) {
        await prisma.surchargeRule.create({ data: { name: rule.name, kind: rule.kind, conditions: rule.conditions as Prisma.InputJsonObject, percent: rule.percent, note: rule.note, isActive: false, sortOrder: (index + 1) * 10 } });
      }
    },
  },
  {
    name: 'import mappings',
    run: async prisma => {
      // The column layouts of Ahmad's own sheets (headings only). Created once: the office edits or switches them off in Settings → Import.
      for (const mapping of SEED_MAPPINGS) {
        await prisma.importMapping.upsert({
          where: { target_name: { target: mapping.target, name: mapping.name } },
          create: {
            name: mapping.name,
            target: mapping.target,
            headers: mapping.columns.map(column => normalizeHeader(column.header)),
            columns: mapping.columns,
            options: mapping.options as Prisma.InputJsonObject,
            isSystem: true,
          },
          update: {},
        });
      }
    },
  },
  {
    name: 'export presets',
    run: async prisma => {
      // A few ready-made exports of the reports centre; created once — the office changes or removes them in Settings → Export presets.
      if (await prisma.exportPreset.count()) return;
      await prisma.exportPreset.createMany({ data: SEED_EXPORT_PRESETS.map(preset => ({ name: preset.name, reportKey: preset.reportKey, format: preset.format, period: preset.period, params: preset.params as Prisma.InputJsonObject })) });
    },
  },
  {
    name: 'owner account',
    run: async prisma => {
      const email = process.env.SEED_OWNER_EMAIL?.trim().toLowerCase();
      const password = process.env.SEED_OWNER_PASSWORD;
      if (!email || !password) {
        console.warn('  SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD are not set — no owner account was created.');
        return;
      }
      if (await prisma.user.findUnique({ where: { email } })) {
        console.log('  The owner account already exists — left untouched.');
        return;
      }
      const role = await prisma.role.findUniqueOrThrow({ where: { key: OWNER_ROLE_KEY } });
      await prisma.user.create({
        data: {
          email,
          name: process.env.SEED_OWNER_NAME?.trim() || 'Owner',
          roleId: role.id,
          status: 'active',
          passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
          passwordChangedAt: new Date(),
          // The password from .env is temporary: the first thing the owner does after signing in is choose their own.
          mustChangePassword: true,
        },
      });
      console.log(`  Created the owner account ${email} (must choose a new password at the first sign-in).`);
    },
  },
];

/** Adds the given seed fields (and the sections they need) to a form document, at the end of their section. */
/** A new system field goes where the seed has it: before the first field that follows it in the seed's section and is in the office's form too (else at the end). */
function appendFields(target: FormDoc, seed: FormDoc, added: FormDoc['fields']): FormDoc {
  const sections = [...target.sections];
  let fields = [...target.fields];
  for (const field of added) {
    if (fields.some(have => have.key === field.key)) continue;
    if (!sections.some(section => section.key === field.section)) {
      const seedSection = seed.sections.find(section => section.key === field.section);
      if (!seedSection) continue;
      sections.push({ ...seedSection, order: sections.length });
    }
    const seedOrder = seed.fields.filter(entry => entry.section === field.section).sort((a, b) => a.order - b.order).map(entry => entry.key);
    const following = new Set(seedOrder.slice(seedOrder.indexOf(field.key) + 1));
    const inSection = fields.filter(have => have.section === field.section).sort((a, b) => a.order - b.order);
    const before = inSection.find(have => following.has(have.key));
    const position = before ? before.order : Math.max(-1, ...inSection.map(have => have.order)) + 1;
    fields = fields.map(have => (have.section === field.section && have.order >= position ? { ...have, order: have.order + 1 } : have));
    fields.push({ ...field, order: position });
  }
  return { ...target, sections, fields };
}

/**
 * One-time changes the system makes to forms that already exist, at the office's request (once a form exists the form builder owns it; these are the
 * exceptions). Each runs once per database: its id is written in the note of the revision it makes (and in the first revision of a form the seed creates
 * with the change already in it). `apply` returns null when there is nothing to change.
 */
interface FormChange {
  id: string;
  entity: string;
  note: string;
  apply: (doc: FormDoc) => FormDoc | null;
}

const FORM_CHANGES: FormChange[] = [
  {
    // Ahmad, 17-10-2026: the contract form does not ask for holiday entitlements and the collective agreement.
    id: 'contract-leave-removed-2026-10-17',
    entity: 'contract',
    note: 'removed the section “Vakantie en cao” (vacation hours per hour, vacation days per year, cao)',
    apply: doc => {
      const retired = new Set(['vacation_hours_per_hour', 'vacation_days_per_year', 'cao']);
      if (!doc.sections.some(section => section.key === 'leave') && !doc.fields.some(field => retired.has(field.key) && field.kind === 'system')) return null;
      const sections = doc.sections.filter(section => section.key !== 'leave').sort((a, b) => a.order - b.order);
      const last = sections.at(-1)?.key ?? 'contract';
      // A field the office added to that section itself moves to the last section, it is not thrown away.
      const moved = doc.fields.filter(field => field.section === 'leave' && !retired.has(field.key));
      const fields = doc.fields
        .filter(field => !(retired.has(field.key) && field.kind === 'system') && !moved.includes(field))
        .concat(moved.map((field, index) => ({ ...field, section: last, order: 1000 + index })));
      return { ...doc, sections: sections.map((section, order) => ({ ...section, order })), fields };
    },
  },
  {
    // With the length in months before the dates, the end date's help text the system shipped says the wrong thing; a text the office wrote is left alone.
    id: 'contract-end-date-help-2026-10-17',
    entity: 'contract',
    note: 'end date: help text for the length in months',
    apply: doc => {
      const field = doc.fields.find(entry => entry.key === 'end_date');
      if (!field || field.help?.nl !== 'De laatste dag van het contract. De duur in maanden wordt hieruit berekend.') return null;
      const help = { nl: 'De laatste dag van het contract. Wordt ingevuld vanuit de duur; je kunt hem ook zelf kiezen.', en: 'The last day of the contract. Filled in from the length; you can also pick it yourself.' };
      return { ...doc, fields: doc.fields.map(entry => (entry === field ? { ...entry, help } : entry)) };
    },
  },
  {
    // Ahmad, 17-10-2026: a date of birth cannot be in the future (the date picker then ends at today).
    id: 'person-birth-date-not-future-2026-10-17',
    entity: 'person',
    note: 'date of birth: no date in the future',
    apply: doc => {
      const field = doc.fields.find(entry => entry.key === 'date_of_birth' && entry.type === 'date');
      if (!field || field.validation?.notFuture) return null;
      return { ...doc, fields: doc.fields.map(entry => (entry === field ? { ...entry, validation: { ...entry.validation, notFuture: true } } : entry)) };
    },
  },
];

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    for (const seeder of seeders) {
      console.log(`Seeding ${seeder.name} …`);
      await seeder.run(prisma);
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
