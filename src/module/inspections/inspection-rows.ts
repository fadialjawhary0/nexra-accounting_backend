import { formatDay } from '../../common/dates.js';
import { fold } from '../../common/text.js';
import type { ChecklistVersion, Inspection, InspectionItem, InspectionItemFile, Prisma } from '../../generated/prisma/client.js';
import { readDoc, type ChecklistDoc } from './checklist-doc.js';
import type { ItemChoice, ItemResult, Summary } from './inspection-matching.js';
import { OPEN_STATUSES } from './inspections.constants.js';

/** What every screen about an inspection needs read together with it. */
export const INSPECTION_INCLUDE = {
  client: { select: { id: true, number: true, name: true, isActive: true } },
  version: { include: { template: { select: { id: true, code: true, nameNl: true, nameEn: true } } } },
  items: { include: { files: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.InspectionInclude;

export type InspectionRow = Inspection & {
  client: { id: string; number: string; name: string; isActive: boolean };
  version: (ChecklistVersion & { template: { id: string; code: string; nameNl: string; nameEn: string } }) | null;
  items: Array<InspectionItem & { files: InspectionItemFile[] }>;
};

export const isOpen = (row: Pick<Inspection, 'status'>): boolean => OPEN_STATUSES.includes(row.status);

/** The lines of the checklist an inspection is prepared with (none when it has no checklist). */
export const docOf = (row: Pick<InspectionRow, 'version'>): ChecklistDoc => (row.version ? readDoc(row.version.sections, row.version.items) : { sections: [], items: [] });

/** What people decided about the lines of the checklist, by code of the line. */
export function choicesOf(items: ReadonlyArray<InspectionItem & { files: ReadonlyArray<Pick<InspectionItemFile, 'fileId' | 'kind'>> }>): Map<string, ItemChoice> {
  const choices = new Map<string, ItemChoice>();
  for (const item of items) {
    if (!item.code) continue;
    choices.set(item.code, {
      decision: item.decision === 'not_applicable' || item.decision === 'asked' || item.decision === 'done' ? item.decision : null,
      added: new Set(item.files.filter(file => file.kind === 'added').map(file => file.fileId)),
      excluded: new Set(item.files.filter(file => file.kind === 'excluded').map(file => file.fileId)),
    });
  }
  return choices;
}

/** The lines somebody added by hand (what the inspector asked for in their own words). */
export const customItemsOf = <T extends Pick<InspectionItem, 'code'>>(items: readonly T[]): T[] => items.filter(item => !item.code);

/** A line added by hand counts like a line of the checklist that has to be ticked: open until somebody says it is done (or does not apply). */
export function addCustomLines(summary: Summary, custom: ReadonlyArray<Pick<InspectionItem, 'decision'>>): Summary {
  const next = { ...summary };
  for (const line of custom) {
    if (line.decision === 'not_applicable') {
      next.notApplicable += 1;
      continue;
    }
    next.total += 1;
    if (line.decision === 'done') next.ready += 1;
    else next.manual += 1;
  }
  next.percent = next.total ? Math.round((next.ready * 100) / next.total) : 100;
  return next;
}

/** The state a line added by hand has: ticked or still to do. */
export const customState = (decision: string | null): ItemResult['state'] => (decision === 'not_applicable' ? 'not_applicable' : decision === 'done' ? 'done' : 'manual');

/** The text the quick search looks in. */
export function searchTextOf(parts: ReadonlyArray<string | null | undefined>): string {
  return [...new Set(parts.map(part => fold(part ?? '')).filter(Boolean))].join(' ');
}

export const day = (value: Date | null): string | null => (value ? formatDay(value) : null);
export const toDay = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
