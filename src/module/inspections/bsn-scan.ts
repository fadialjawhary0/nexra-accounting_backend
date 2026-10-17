/*
 * Finding citizen service numbers (BSN) in the text of a document, so a bundle for an inspector is not handed over with numbers the privacy rules keep out of it
 * (docs/11: the inspector's own list says so — except in an ID copy and the payroll-tax form). The check is the "eleven test" every BSN passes; a number that passes
 * and stands next to the word "BSN" (or "burgerservicenummer", "sofinummer") is a certain find, any other bare nine-digit number that passes is a possible one.
 */

/** The eleven test: nine digits, the first eight weighed 9 … 2 and the last −1, a sum that is a multiple of eleven and not zero. */
export function isValidBsn(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const weights = [9, 8, 7, 6, 5, 4, 3, 2, -1];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(digits[index]), 0);
  return sum !== 0 && sum % 11 === 0;
}

/** A nine-digit number that stands on its own — not a piece of a longer number, an IBAN, a VAT number (`NL…B01`) or a payroll-tax number (`…L01`) — optionally written `123 456 782` or `123.456.782`. */
const CANDIDATE = /(?<![0-9A-Za-z])(\d{3})([ .-]?)(\d{3})\2(\d{3})(?![0-9A-Za-z])/g;
const KEYWORD = /bsn|burgerservice|sofi[ -]?nummer|sofi\b|sociaal[ -]fiscaal/i;
/** How far before a number the word may stand. */
const LOOK_BEHIND = 48;

export interface BsnFinding {
  /** Valid numbers next to the word BSN. */
  certain: number;
  /** Other valid nine-digit numbers (many are amounts or reference numbers that only look like a BSN). */
  possible: number;
  /** The first find with all but its last two digits hidden (`•••••••82`), for showing — never the number itself. */
  example: string | null;
}

/** Looks through a text. A separated number (`123 456 782`) only counts when the word BSN is next to it, since amounts and phone numbers are written like that too. */
export function findBsns(text: string): BsnFinding {
  let certain = 0;
  let possible = 0;
  let example: string | null = null;
  for (const match of text.matchAll(CANDIDATE)) {
    const digits = `${match[1]}${match[3]}${match[4]}`;
    if (!isValidBsn(digits)) continue;
    const before = text.slice(Math.max(0, (match.index ?? 0) - LOOK_BEHIND), match.index ?? 0);
    const named = KEYWORD.test(before);
    const separated = match[2] !== '';
    if (named) certain += 1;
    else if (!separated) possible += 1;
    else continue;
    example ??= `${'•'.repeat(7)}${digits.slice(-2)}`;
  }
  return { certain, possible, example };
}
