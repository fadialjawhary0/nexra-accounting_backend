/** Lower-case, accent-free, single-spaced: how text is compared and searched everywhere. */
export const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Escapes the characters that mean something inside a SQL LIKE pattern. */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, character => `\\${character}`);
