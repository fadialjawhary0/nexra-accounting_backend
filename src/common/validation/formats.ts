/**
 * Format checks for the Dutch data the office works with (postcode, KvK, BTW-nummer, IBAN, BSN, telephone …). Each check
 * returns the **normalised** value (what is stored) or `null` when the input is not valid; the failing message is always
 * `validation.<messageKey>` in the frontend's translation files. The frontend has the same functions
 * (`src/lib/validators/formats.js`) for instant feedback — the API is the authority.
 */
export type FormatName = 'email' | 'phone' | 'url' | 'postcode' | 'kvk' | 'vat' | 'iban' | 'bsn' | 'rsin' | 'payrollTaxNumber';

interface Format {
  /** Normalises and validates; `null` = invalid. */
  normalize: (input: string) => string | null;
  /** `validation.<messageKey>` */
  messageKey: string;
}

const digitsOnly = (value: string) => value.replace(/\D/g, '');

/** The Dutch "elfproef": weights 9 … 2 and −1 over nine digits must sum to a multiple of 11 (BSN, RSIN). */
const passesElevenTest = (digits: string): boolean => {
  if (!/^\d{9}$/.test(digits) || /^0+$/.test(digits)) return false;
  const sum = [...digits].reduce((total, digit, index) => total + Number(digit) * (index === 8 ? -1 : 9 - index), 0);
  return sum % 11 === 0;
};

/** ISO 13616 mod-97 check; `compact` is upper case without spaces. */
const passesMod97 = (compact: string): boolean => {
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
};

/** Length of an IBAN per country for the countries we expect; others only get the generic 15–34 range. */
const IBAN_LENGTH: Record<string, number> = { NL: 18, BE: 16, DE: 22, FR: 27, GB: 22, ES: 24, IT: 27, LU: 20, PT: 25, AT: 20, IE: 22, PL: 28, TR: 26 };

export const FORMATS: Record<FormatName, Format> = {
  email: {
    messageKey: 'invalidEmail',
    normalize: input => {
      const value = input.trim().toLowerCase();
      return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? value : null;
    },
  },
  phone: {
    messageKey: 'invalidPhone',
    /** `06 12 34 56 78`, `+31 6 12345678`, `0031612345678` → `+31612345678` (international, no spaces). Other countries keep their `+` number. */
    normalize: input => {
      let value = input.trim().replace(/[\s().-]/g, '');
      if (value.startsWith('00')) value = `+${value.slice(2)}`;
      if (value.startsWith('0')) value = `+31${value.slice(1)}`;
      return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
    },
  },
  url: {
    messageKey: 'invalidUrl',
    normalize: input => {
      const raw = input.trim();
      if (!raw) return null;
      try {
        const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
        return ['http:', 'https:'].includes(url.protocol) && url.hostname.includes('.') ? url.toString().replace(/\/$/, '') : null;
      } catch {
        return null;
      }
    },
  },
  postcode: {
    messageKey: 'invalidPostcode',
    /** `1234ab` → `1234 AB` (the letter pairs SA, SD and SS are never used). */
    normalize: input => {
      const match = input.trim().match(/^([1-9]\d{3})\s?([A-Za-z]{2})$/);
      if (!match) return null;
      const letters = match[2]!.toUpperCase();
      return ['SA', 'SD', 'SS'].includes(letters) ? null : `${match[1]} ${letters}`;
    },
  },
  kvk: {
    messageKey: 'invalidKvk',
    normalize: input => {
      const value = input.replace(/\s/g, '');
      return /^\d{8}$/.test(value) ? value : null;
    },
  },
  vat: {
    messageKey: 'invalidVat',
    /** Dutch BTW-nummer `NL123456789B01` (dots and spaces are tolerated). */
    normalize: input => {
      const value = input.replace(/[\s.-]/g, '').toUpperCase();
      return /^NL\d{9}B\d{2}$/.test(value) ? value : null;
    },
  },
  iban: {
    messageKey: 'invalidIban',
    normalize: input => {
      const value = input.replace(/\s/g, '').toUpperCase();
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return null;
      const expected = IBAN_LENGTH[value.slice(0, 2)];
      if (expected && value.length !== expected) return null;
      return passesMod97(value) ? value : null;
    },
  },
  bsn: {
    messageKey: 'invalidBsn',
    /** Eight-digit numbers get their leading zero back. */
    normalize: input => {
      const value = digitsOnly(input).padStart(9, '0');
      return value.length === 9 && passesElevenTest(value) ? value : null;
    },
  },
  rsin: {
    messageKey: 'invalidRsin',
    normalize: input => {
      const value = digitsOnly(input);
      return value.length === 9 && passesElevenTest(value) ? value : null;
    },
  },
  payrollTaxNumber: {
    messageKey: 'invalidPayrollTaxNumber',
    /** Loonheffingennummer: nine digits, `L`, two digits. */
    normalize: input => {
      const value = input.replace(/[\s.-]/g, '').toUpperCase();
      return /^\d{9}L\d{2}$/.test(value) ? value : null;
    },
  },
};

export const FORMAT_NAMES = Object.keys(FORMATS) as FormatName[];

/** Normalised value, or `null` when `input` does not fit the format. */
export const normalizeFormat = (format: FormatName, input: string): string | null => FORMATS[format].normalize(input);
