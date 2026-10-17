/*
 * Columns that hold more than one value, as spreadsheets do: "Hoofdstraat 12 A" (street, number and suffix), "1234 AB Amsterdam" (postcode and
 * city) and "Jan van der Berg" (first name, name prefix and last name). They are split with plain rules; a split that is a guess is marked as such.
 */

export interface AddressParts {
  street: string;
  house_number?: string;
  house_number_suffix?: string;
}

/** `Hoofdstraat 12 A` · `Kerkstraat 5-2` · `Van Heemstraweg West 3b` · `Laan 1940-1945 12` → street, number, suffix. Without a number the whole text is the street. */
export function splitAddress(raw: string): AddressParts | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const match = /^(.*?[A-Za-zÀ-ÿ.'’)])[\s,]+(\d{1,5})\s*[-/ ]?\s*([A-Za-z]{1,3}|\d{1,4}|bis|hs|[IVX]{1,4})?$/i.exec(text);
  if (!match) return { street: text };
  const suffix = match[3]?.trim();
  return { street: match[1]!.trim().replace(/,$/, ''), house_number: match[2]!, ...(suffix && { house_number_suffix: suffix }) };
}

export interface PostcodeCity {
  postal_code: string;
  city: string;
}

/** `1234 AB Amsterdam` · `1234AB  Den Haag` → postcode and city. */
export function splitPostcodeCity(raw: string): PostcodeCity | null {
  const match = /^\s*(\d{4})\s?([A-Za-z]{2})[\s,]+(.+?)\s*$/.exec(raw);
  return match ? { postal_code: `${match[1]} ${match[2]!.toUpperCase()}`, city: match[3]! } : null;
}

export interface NameParts {
  first_name?: string;
  infix?: string;
  last_name: string;
  /** The name was a single word or an unusual shape: the split is a guess. */
  guessed: boolean;
}

const PARTICLES = new Set(['van', 'de', 'der', 'den', 'ter', 'ten', 'het', 'te', 'la', 'le', 'el', 'al', 'bin', 'von', 'du', 'da', 'di', "'t", 't']);

/**
 * `Jan van der Berg` → Jan · van der · Berg; `Berg, Jan van der` → Jan · van der · Berg; `J.P. de Vries` → J.P. · de · Vries. One word is a last name.
 */
export function splitFullName(raw: string): NameParts | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  let first: string[];
  let rest: string[];
  if (text.includes(',')) {
    const [last = '', given = ''] = text.split(',').map(part => part.trim());
    rest = last.split(' ').filter(Boolean);
    first = given.split(' ').filter(Boolean);
    // "Berg, Jan van der": the prefix after the given name belongs to the last name.
    const tail: string[] = [];
    while (first.length > 1 && PARTICLES.has(first[first.length - 1]!.toLowerCase())) tail.unshift(first.pop()!);
    rest = [...tail, ...rest];
  } else {
    const words = text.split(' ');
    if (words.length === 1) return { last_name: words[0]!, guessed: true };
    const index = words.findIndex((word, position) => position > 0 && PARTICLES.has(word.toLowerCase()));
    if (index > 0) {
      first = words.slice(0, index);
      rest = words.slice(index);
    } else {
      first = words.slice(0, -1);
      rest = words.slice(-1);
    }
  }
  const infix: string[] = [];
  while (rest.length > 1 && PARTICLES.has(rest[0]!.toLowerCase())) infix.push(rest.shift()!.toLowerCase());
  const last = rest.join(' ');
  if (!last) return null;
  return { ...(first.length && { first_name: first.join(' ') }), ...(infix.length && { infix: infix.join(' ') }), last_name: last, guessed: first.length > 2 };
}
