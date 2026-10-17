import { fold } from '../../common/text.js';
import { DOC_TYPES } from './imports.constants.js';
import { parseDutchDate } from './value-coercion.js';

/**
 * Sorting files without the AI: Ahmad's OneDrive tree already says a lot. A folder `<nr>- <name>` is a client, `0-GESTOPT` holds stopped clients
 * and workers, a folder named after a date is an inspection, and a file called "paspoort jan.pdf" is an ID. These are plain rules in code (the AI
 * only gets the files the rules cannot place); the document types themselves, and the standard folder each goes to, are the office's setting
 * (Settings → Documents → Types).
 */

export interface PathHints {
  /** The text before the first dash of the client's folder ("042" of "042- Bakkerij Jansen"), when a segment looks like one. */
  clientNumbers: string[];
  /** What follows the number in that folder name ("Bakkerij Jansen"). */
  clientLabel: string | null;
  /** The file sits in a `0-GESTOPT` folder: the client or the worker has stopped. */
  stopped: boolean;
  /** The deepest folder that is no standard folder and no date: probably a worker's name. */
  workerFolder: string | null;
  /** A standard folder of the client the path runs through (a code of the folder template). */
  folderCode: string | null;
  docType: string | null;
  /** The pattern is specific enough that the AI need not look at the file to sort it. */
  strong: boolean;
  docDate: string | null;
  /** Why the type was chosen: the file `name` or a folder (`path`) or a dated folder (`date`). */
  source: 'name' | 'path' | 'date' | null;
}

/** A folder that only holds things (a standard folder of a client, or "Documenten"): the names it is known by (folded) and, for a standard folder, its code. */
export interface KnownFolder {
  code: string | null;
  names: string[];
}

interface Pattern {
  type: string;
  /** Matched against the folded name without its extension. */
  match: RegExp;
  strong: boolean;
}

/** Most specific first: the first pattern that matches decides. */
const PATTERNS: Pattern[] = [
  { type: DOC_TYPES.gAccount, match: /\bg[- ]?(rekening|account)|deblokkering/, strong: true },
  { type: DOC_TYPES.paymentBehaviour, match: /betalingsgedrag|payment behaviou?r/, strong: true },
  { type: DOC_TYPES.trialBalance, match: /kolommenbalans|saldibalans|trial balance/, strong: true },
  { type: DOC_TYPES.kvkExtract, match: /\bkvk\b|uittreksel|handelsregister|chamber of commerce/, strong: true },
  { type: DOC_TYPES.residencePermit, match: /verblijf|vergunning|\bpermit\b|residence|tewerkstelling|gvva|\bvvr\b|\bmvv\b|werkvergunning/, strong: true },
  { type: DOC_TYPES.idDocument, match: /paspoort|passport|identiteit|identity|\bid[- ]?(kaart|card|bewijs)\b|idkaart|rijbewijs|driving|legitimatie/, strong: true },
  { type: DOC_TYPES.payslip, match: /loonstrook|loonspecificatie|salarisstrook|salarisspecificatie|payslip/, strong: true },
  { type: DOC_TYPES.timesheet, match: /urenstaat|urenstaten|urenregistratie|urenbriefje|urenlijst|uren[- ]?overzicht|timesheet|weekstaat|\bweek[- ]?\d{1,2}\b/, strong: true },
  { type: DOC_TYPES.staffingInvoice, match: /uitzend|detachering|inleen|payroll/, strong: false },
  { type: DOC_TYPES.annualAccounts, match: /jaarrekening|jaarverslag|annual (accounts|report)/, strong: false },
  { type: DOC_TYPES.taxReturn, match: /aangifte|beschikking|aanslag|omzetbelasting|inkomstenbelasting|vennootschapsbelasting|loonheffing|\bbtw\b|\bvpb\b/, strong: false },
  { type: DOC_TYPES.contract, match: /arbeidsovereenkomst|arbeidscontract|dienstverband|oproepcontract|nulurencontract|\bcontract\b|overeenkomst|\baov\b/, strong: false },
  { type: DOC_TYPES.invoice, match: /factuur|invoice|\bnota\b|creditnota/, strong: false },
  { type: DOC_TYPES.letter, match: /\bbrief\b|letter|schrijven|aanmaning|herinnering|correspondentie/, strong: false },
  { type: DOC_TYPES.form, match: /formulier|aanvraag|verzoek|melding|\bform\b/, strong: false },
  { type: DOC_TYPES.timesheet, match: /\buren\b/, strong: false },
  { type: DOC_TYPES.inspection, match: /controle|inspectie|nen[- ]?4400|\bsna\b|audit/, strong: false },
];

const MONTH_NAMES = 'jan(?:uari)?|feb(?:ruari)?|maart|mrt|apr(?:il)?|mei|juni?|juli?|aug(?:ustus)?|sep(?:t(?:ember)?)?|okt(?:ober)?|nov(?:ember)?|dec(?:ember)?';

/** The file name without its extension and path. */
export const baseName = (path: string): string => {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

/** `0-GESTOPT`, `0- GESTOPT`, `0 - gestopt` (and "Gestopt klanten"): where stopped clients and workers are kept. */
const isStoppedFolder = (segment: string): boolean => /^0?\s*[-–]?\s*gestopt/.test(fold(segment));

/** A folder that is named after a day, a month or a year: an inspection or a period, not a client or a worker. */
export function folderDate(segment: string): string | null {
  const text = segment.trim();
  const iso = /^(\d{4})[-_. ](\d{1,2})(?:[-_. ](\d{1,2}))?$/.exec(text);
  if (iso) return parseDutchDate(`${iso[1]}-${iso[2]}-${iso[3] ?? '1'}`);
  const dutch = /^(\d{1,2})[-_. ](\d{1,2})[-_. ](\d{4})$/.exec(text);
  if (dutch) return parseDutchDate(`${dutch[1]}-${dutch[2]}-${dutch[3]}`);
  const named = new RegExp(`^(?:(\\d{1,2})[-_. ]*)?(${MONTH_NAMES})\\.?[-_. ]*(\\d{4})$`, 'i').exec(fold(text));
  if (named) return parseDutchDate(`${named[1] ?? '1'} ${named[2]} ${named[3]}`);
  return null;
}

/** A date written in a file name: `2026-03-15`, `15-03-2026`, `20260315`, `15 maart 2026`, `maart 2026`. */
export function dateInName(name: string): string | null {
  const text = fold(name);
  let match = /(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})/.exec(text);
  if (match) return parseDutchDate(`${match[1]}-${match[2]}-${match[3]}`);
  match = /(\d{1,2})[-_.](\d{1,2})[-_.](\d{4})/.exec(text);
  if (match) return parseDutchDate(`${match[1]}-${match[2]}-${match[3]}`);
  match = /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/.exec(text);
  if (match && Number(match[1]) > 1990) return parseDutchDate(`${match[1]}-${match[2]}-${match[3]}`);
  match = new RegExp(`(?:(\\d{1,2})[-_. ]*)?(${MONTH_NAMES})\\.?[-_. ]*(\\d{4})`).exec(text);
  if (match) return parseDutchDate(`${match[1] ?? '1'} ${match[2]} ${match[3]}`);
  return null;
}

/** What a segment says about a client's number: `042- Bakkerij` → `042`; `K-042 Bakkerij` → `K-042`. */
function numberOfFolder(segment: string): { number: string; label: string } | null {
  const dashed = /^([A-Za-z0-9][A-Za-z0-9._]{0,19}?)\s*[-–]\s+(.{2,})$/.exec(segment.trim());
  if (dashed) return { number: dashed[1]!, label: dashed[2]!.trim() };
  const prefixed = /^([A-Za-z]{1,3}[-.]?\d{1,8})\s+(.{2,})$/.exec(segment.trim());
  return prefixed ? { number: prefixed[1]!, label: prefixed[2]!.trim() } : null;
}

/**
 * Reads what a path says. `path` uses `/`, the last piece is the file. `known` are the standard folders of a client (the folder template): a folder
 * of that name is not a worker, and says where the file belongs.
 */
export function readPath(path: string, known: readonly KnownFolder[]): PathHints {
  const parts = path.split('/').filter(Boolean);
  const file = parts.pop() ?? '';
  const folders = parts;
  const knownByName = new Map(known.flatMap(folder => folder.names.map(name => [fold(name), folder.code] as const)));
  /** Folders that explain something (a client, `0-GESTOPT`, a date) and folders that only hold things. */
  const consumed = new Set<number>();
  const containers = new Set<number>();

  const hints: PathHints = { clientNumbers: [], clientLabel: null, stopped: false, workerFolder: null, folderCode: null, docType: null, strong: false, docDate: null, source: null };
  folders.forEach((segment, index) => {
    if (isStoppedFolder(segment)) {
      hints.stopped = true;
      consumed.add(index);
      return;
    }
    if (knownByName.has(fold(segment))) {
      const code = knownByName.get(fold(segment));
      if (code) hints.folderCode = code;
      containers.add(index);
      return;
    }
    const numbered = numberOfFolder(segment);
    if (numbered && numbered.number !== '0' && !folderDate(segment)) {
      hints.clientNumbers.push(numbered.number);
      hints.clientLabel ??= numbered.label;
      consumed.add(index);
    }
  });

  // A dated folder is an inspection (or a period); the date is the day of the folder.
  for (let index = folders.length - 1; index >= 0; index -= 1) {
    const date = folderDate(folders[index]!);
    if (date) {
      consumed.add(index);
      hints.docDate = date;
      hints.docType = DOC_TYPES.inspection;
      hints.source = 'date';
      hints.strong = true;
      hints.folderCode ??= 'inspections';
      break;
    }
  }

  // The deepest folder that nothing above explained is the worker (a person's name), when there is a client folder above it.
  if (hints.clientNumbers.length) {
    for (let index = folders.length - 1; index >= 0; index -= 1) {
      if (!consumed.has(index) && !containers.has(index) && /\p{L}/u.test(folders[index]!) && folders[index]!.length <= 60) {
        hints.workerFolder = folders[index]!;
        break;
      }
    }
  }

  const name = fold(baseName(file));
  const named = PATTERNS.find(pattern => pattern.match.test(name));
  if (named && hints.source !== 'date') {
    hints.docType = named.type;
    hints.strong = named.strong;
    hints.source = 'name';
  } else if (!hints.docType) {
    // A folder that is not a standard one, a date or a person may say what is in it ("Loonstroken", "Paspoorten").
    const folder = folders.map((segment, index) => ({ segment, index })).reverse().find(({ segment, index }) => !consumed.has(index) && PATTERNS.some(pattern => pattern.match.test(fold(segment))));
    const byFolder = folder ? PATTERNS.find(pattern => pattern.match.test(fold(folder.segment))) : undefined;
    if (byFolder) {
      hints.docType = byFolder.type;
      hints.strong = false;
      hints.source = 'path';
      if (folder && hints.workerFolder === folder.segment) hints.workerFolder = null;
    }
  }
  hints.docDate ??= dateInName(baseName(file));
  return hints;
}

