import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { personName } from '../people/person-record.js';

export interface TaskLink {
  type: string;
  id: string;
  /** How the record is called ("042 – Bakkerij Jansen", "J. Jansen · 042"). */
  label: string;
  /** The client behind it: the record itself for a client, otherwise the client it belongs to. */
  clientId: string | null;
}

/**
 * What a task can be about. The label is what the task shows for the record, and the client behind it is stored with the task, so "all the tasks of this client" is one
 * query — whether they are about the client itself, one of its workers, a contract, an invoice, an inspection or a document.
 */
@Injectable()
export class TaskLinksService {
  constructor(private readonly prisma: PrismaService) {}

  /** `null` when the record does not exist (or is of a kind a task cannot be about). */
  async resolve(type: string, id: string): Promise<TaskLink | null> {
    switch (type) {
      case 'client': {
        const client = await this.prisma.client.findUnique({ where: { id }, select: { id: true, number: true, name: true } });
        return client ? { type, id, label: `${client.number} – ${client.name}`, clientId: client.id } : null;
      }
      case 'employee': {
        const employee = await this.prisma.employee.findUnique({ where: { id }, select: { id: true, clientId: true, client: { select: { number: true } }, person: { select: { firstName: true, lastName: true, data: true } } } });
        return employee ? { type, id, label: `${personName(employee.person)} · ${employee.client.number}`, clientId: employee.clientId } : null;
      }
      case 'contract': {
        const contract = await this.prisma.contract.findUnique({
          where: { id },
          select: { id: true, clientId: true, startDate: true, client: { select: { number: true } }, employee: { select: { person: { select: { firstName: true, lastName: true, data: true } } } } },
        });
        return contract ? { type, id, label: `${personName(contract.employee.person)} · ${contract.client.number}`, clientId: contract.clientId } : null;
      }
      case 'invoice': {
        const invoice = await this.prisma.invoice.findUnique({ where: { id }, select: { id: true, number: true, direction: true, clientId: true, client: { select: { number: true } } } });
        return invoice ? { type, id, label: `${invoice.number ?? (invoice.direction === 'outgoing' ? '—' : '?')} · ${invoice.client.number}`, clientId: invoice.clientId } : null;
      }
      case 'inspection': {
        const inspection = await this.prisma.inspection.findUnique({ where: { id }, select: { id: true, number: true, clientId: true, client: { select: { name: true } } } });
        return inspection ? { type, id, label: `${inspection.number} · ${inspection.client.name}`, clientId: inspection.clientId } : null;
      }
      case 'file': {
        const file = await this.prisma.storedFile.findFirst({ where: { id, isActive: true }, select: { id: true, name: true, clientId: true } });
        return file ? { type, id, label: file.name, clientId: file.clientId } : null;
      }
      default:
        return null;
    }
  }
}
