import { Injectable, NotFoundException } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { asRecord } from '../../common/record-values.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { MessageTemplate } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { personName } from '../people/person-record.js';
import { canViewField } from '../forms/field-access.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormsService } from '../forms/forms.service.js';
import { fillText } from '../templates/merge-format.js';
import { MergeFieldsService } from '../templates/merge-fields.service.js';
import type { CreateMessageTemplateDto, MessageTemplateQuery, UpdateMessageTemplateDto, WhatsAppLinkDto } from './dto/messaging.dto.js';

/** `+31 6 12345678` → `31612345678`; a Dutch `06 12345678` becomes `31612345678` too. `null` when there is no number. */
export function whatsappNumber(phone: unknown): string | null {
  const cleaned = String(phone ?? '').replace(/[^\d+]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('+')) return cleaned.slice(1) || null;
  if (cleaned.startsWith('00')) return cleaned.slice(2) || null;
  if (cleaned.startsWith('0')) return `31${cleaned.slice(1)}`;
  return cleaned;
}

/**
 * Ready-made messages (WhatsApp) with merge fields. Pressing "Open WhatsApp" next to a contract or a reminder turns a template into the text of one
 * contract and a `https://wa.me/…` link: the chat opens in WhatsApp with the message typed in, and the person presses send themselves — no business
 * account, nothing is sent by the system. Each time a link is made it is written in the contract's history.
 */
@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
    private readonly records: FormRecordsService,
    private readonly merge: MergeFieldsService,
  ) {}

  /* ── Templates ────────────────────────────────────────────────────────────────────────────────────────────────── */

  async list(query: MessageTemplateQuery, locale: AppLocale) {
    const rows = await this.prisma.messageTemplate.findMany({
      where: { channel: 'whatsapp', ...(query.scope && { scope: query.scope }), ...(query.audience && { audience: query.audience }), ...(query.all !== 'true' && { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(row => this.serialize(row, locale));
  }

  async create(dto: CreateMessageTemplateDto, locale: AppLocale) {
    const last = await this.prisma.messageTemplate.findFirst({ orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    const row = await this.prisma.messageTemplate.create({
      data: { name: dto.name.trim(), bodyNl: dto.bodyNl.trim(), bodyEn: dto.bodyEn.trim(), audience: dto.audience ?? 'worker', sortOrder: dto.sortOrder ?? (last?.sortOrder ?? 0) + 10 },
    });
    await this.audit.log({ action: 'created', entityType: 'message_template', entityId: row.id, entityLabel: row.name, after: { name: row.name, audience: row.audience } });
    return this.serialize(row, locale);
  }

  async update(id: string, dto: UpdateMessageTemplateDto, locale: AppLocale) {
    const row = await this.findOrThrow(id);
    const data = {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.bodyNl !== undefined && { bodyNl: dto.bodyNl.trim() }),
      ...(dto.bodyEn !== undefined && { bodyEn: dto.bodyEn.trim() }),
      ...(dto.audience !== undefined && { audience: dto.audience }),
      ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    };
    if (!Object.keys(data).length) return this.serialize(row, locale);
    const updated = await this.prisma.messageTemplate.update({ where: { id }, data });
    const before = { name: row.name, bodyNl: row.bodyNl, bodyEn: row.bodyEn, audience: row.audience, isActive: row.isActive };
    const after = { name: updated.name, bodyNl: updated.bodyNl, bodyEn: updated.bodyEn, audience: updated.audience, isActive: updated.isActive };
    const diff = AuditService.changes(before, after);
    if (Object.keys(diff.after).length) await this.audit.log({ action: dto.isActive === false && row.isActive ? 'deactivated' : dto.isActive === true && !row.isActive ? 'activated' : 'updated', entityType: 'message_template', entityId: id, entityLabel: updated.name, before: diff.before, after: diff.after });
    return this.serialize(updated, locale);
  }

  /* ── The link ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The message of a template written for one contract, and the link that opens the chat with the worker (or the client's contact person). */
  async whatsappLink(dto: WhatsAppLinkDto, user: AuthenticatedUser) {
    const template = dto.templateId
      ? await this.prisma.messageTemplate.findFirst({ where: { id: dto.templateId, isActive: true } })
      : dto.templateCode
        ? await this.prisma.messageTemplate.findFirst({ where: { code: dto.templateCode, isActive: true } })
        : null;
    if (!template) throw validationFailed({ templateId: 'validation.invalid' });
    const contract = await this.prisma.contract.findUnique({ where: { id: dto.contractId }, include: { client: true, employee: { include: { person: true } } } });
    if (!contract) throw new NotFoundException({ code: 'not_found', message: 'Contract not found' });

    const to = dto.to ?? (template.audience === 'client' ? 'client' : 'worker');
    const language = dto.language ?? 'nl';
    const data = await this.merge.forContract(contract.id, language, user.matrix);
    const text = fillText(language === 'nl' ? template.bodyNl : template.bodyEn, data);

    // The phone number comes from the record's own form fields (mobile first), and only when the person may see them.
    const doc = (await this.forms.live(to === 'worker' ? 'person' : 'client')).doc;
    const source = to === 'worker' ? asRecord(contract.employee.person.data) : asRecord(contract.client.data);
    const values = this.records.publicValues(source);
    const keys = to === 'worker' ? ['mobile', 'phone'] : ['phone_1', 'phone_2'];
    const phone = keys
      .map(key => {
        const field = doc.fields.find(entry => entry.key === key);
        return field && field.active && canViewField(field, user.matrix) ? values[key] : undefined;
      })
      .find(value => typeof value === 'string' && value.trim());
    const number = whatsappNumber(phone);
    const name = to === 'worker' ? personName(contract.employee.person) : contract.client.name;

    await this.audit.log({
      action: 'whatsapp',
      entityType: 'contract',
      entityId: contract.id,
      entityLabel: `${contract.client.number} – ${personName(contract.employee.person)}`,
      meta: { to, recipient: name, template: template.code ?? template.name, language, hasNumber: Boolean(number) },
    });
    return { url: number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null, text, phone: number, to, name };
  }

  private serialize(row: MessageTemplate, locale: AppLocale) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      channel: row.channel,
      scope: row.scope,
      audience: row.audience,
      bodyNl: row.bodyNl,
      bodyEn: row.bodyEn,
      body: locale === 'nl' ? row.bodyNl : row.bodyEn,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      isSystem: row.code !== null,
    };
  }

  private async findOrThrow(id: string): Promise<MessageTemplate> {
    const row = await this.prisma.messageTemplate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Message not found' });
    return row;
  }
}
