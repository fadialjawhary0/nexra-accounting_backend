import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../lib/database/prisma.service.js';

/** The tables whose `searchText` has a trigram index. The names are constants, never typed by a person. */
export type FuzzyTable = 'Client' | 'Person' | 'Employee';

/**
 * Typo-tolerant search: a word that is spelled a little differently ("schoonmak", "Jansen" for "Janssen") still finds the record. It uses the trigram word similarity of
 * PostgreSQL (the `<%` operator, threshold 0.6) on the accent-free `searchText` that every record keeps, best match first. Words shorter than four letters are not matched this way.
 */
export async function fuzzyIds(prisma: PrismaService, table: FuzzyTable, folded: string, limit: number): Promise<string[]> {
  if (folded.length < 4) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE ${folded} <% "searchText" ORDER BY word_similarity(${folded}, "searchText") DESC LIMIT ${limit}`,
  );
  return rows.map(row => row.id);
}
