import type { PdfBox, PdfFieldInfo, PdfPageLayout, PdfTextLine } from '../../lib/pdf/pdf.types.js';
import { SETUP_STATUSES, type SetupStatus } from './official-forms.constants.js';

/*
 * The AI set-up of an edition (`OfficialFormVersion.setup`): what happened when a PDF was uploaded — the AI linking its fields to the records, or finding the boxes of a
 * PDF without fields — so the screens can say "the AI is busy", "the AI linked 34 fields, check them" or "the AI is off, link them yourself".
 */

export interface FormSetup {
  status: SetupStatus;
  /** Why it failed: an AI error code (`ai_budget_exceeded` …), `queue_unavailable` or `setup_failed`. */
  error: string;
  /** When it finished (ISO). */
  at: string | null;
  /** `fields`: the PDF has fields of its own; `flat`: it has none, the answers are written onto the page in placed boxes. */
  mode: 'fields' | 'flat';
  /** Fields the AI linked (`fields`) or boxes it placed (`flat`) the last time. */
  linked: number;
  /** The fields the AI linked that nobody has checked yet: until the mapping is saved by a person, the screens ask to check them. */
  suggested: string[];
  /** Put the name, code, subject and period the AI reads on the form — only while the form still has the names it got when its PDF was uploaded. */
  details: boolean;
  namesAtUpload: { nl: string; en: string } | null;
  /** Place the boxes again even when there are some (`flat`): the AI's boxes replace the ones there were. */
  replace: boolean;
  /** The size of every page, in points (for checking boxes placed on them). */
  pages: Array<{ width: number; height: number }>;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The set-up as stored, tolerant of an empty or old shape. */
export function readSetup(stored: unknown): FormSetup {
  const raw = record(stored);
  const names = record(raw.namesAtUpload);
  return {
    status: (SETUP_STATUSES as readonly string[]).includes(raw.status as string) ? (raw.status as SetupStatus) : 'none',
    error: typeof raw.error === 'string' ? raw.error : '',
    at: typeof raw.at === 'string' ? raw.at : null,
    mode: raw.mode === 'flat' ? 'flat' : 'fields',
    linked: typeof raw.linked === 'number' ? raw.linked : 0,
    suggested: Array.isArray(raw.suggested) ? raw.suggested.filter((name): name is string => typeof name === 'string') : [],
    details: raw.details === true,
    namesAtUpload: typeof names.nl === 'string' && typeof names.en === 'string' ? { nl: names.nl, en: names.en } : null,
    replace: raw.replace === true,
    pages: Array.isArray(raw.pages)
      ? raw.pages.flatMap(page => {
          const size = record(page);
          return typeof size.width === 'number' && typeof size.height === 'number' ? [{ width: size.width, height: size.height }] : [];
        })
      : [],
  };
}

/** What the screens are told about the set-up of an edition. */
export function setupView(setup: FormSetup) {
  return { status: setup.status, error: setup.error, at: setup.at, mode: setup.mode, linked: setup.linked, unchecked: setup.suggested.length };
}

/* ── The words next to a field ──────────────────────────────────────────────────────────────────────────────────── */

const bottomOf = (box: PdfBox) => box.y + box.height;
const rightOf = (box: PdfBox) => box.x + box.width;

/**
 * The question printed next to a field: the text on its left on the same line, else the text just above it; for a check box the text right after it. This is what
 * a person reads on the form — and what the AI is told, because the names of the fields of official PDFs are often only codes ("Text12").
 */
export function contextOf(box: PdfBox | null, kind: PdfFieldInfo['kind'], lines: readonly PdfTextLine[]): string {
  if (!box) return '';
  const middle = box.y + box.height / 2;
  const sameRow = (line: PdfTextLine) => Math.abs(line.box.y + line.box.height / 2 - middle) <= Math.max(4, box.height / 2);
  const pick = (candidates: PdfTextLine[], distance: (line: PdfTextLine) => number) => candidates.sort((one, two) => distance(one) - distance(two))[0]?.text ?? '';

  if (kind === 'checkbox' || kind === 'radio') {
    const after = pick(lines.filter(line => sameRow(line) && line.box.x >= rightOf(box) - 2 && line.box.x - rightOf(box) < 220), line => line.box.x - rightOf(box));
    if (after) return after.slice(0, 160);
  }
  const before = pick(lines.filter(line => sameRow(line) && rightOf(line.box) <= box.x + 4 && box.x - rightOf(line.box) < 260), line => box.x - rightOf(line.box));
  if (before) return before.slice(0, 160);
  const above = pick(
    lines.filter(line => bottomOf(line.box) <= box.y + 2 && box.y - bottomOf(line.box) < 26 && line.box.x < rightOf(box) && rightOf(line.box) > box.x - 30),
    line => box.y - bottomOf(line.box) + Math.abs(line.box.x - box.x) / 50,
  );
  if (above) return above.slice(0, 160);
  const inside = pick(lines.filter(line => line.box.x >= box.x - 1 && rightOf(line.box) <= rightOf(box) + 1 && line.box.y >= box.y - 1 && bottomOf(line.box) <= bottomOf(box) + 1), line => line.box.y);
  return inside.slice(0, 160);
}

/** The fields with the words next to them, read from the layout of their pages. */
export function withContext(fields: PdfFieldInfo[], layout: readonly PdfPageLayout[]): PdfFieldInfo[] {
  const byPage = new Map(layout.map(page => [page.page, page.lines]));
  return fields.map(field => (field.placed || field.context ? field : { ...field, context: contextOf(field.box, field.kind, byPage.get(field.page) ?? []) }));
}
