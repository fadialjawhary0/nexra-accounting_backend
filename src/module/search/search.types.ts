import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';

/** One thing that was found: a client, a worker, a contract, a document … */
export interface SearchHit {
  id: string;
  title: string;
  subtitle: string;
  /** The screen that shows it. */
  href: string;
  /** For a document found by what it says: the piece of its text around the words. */
  snippet?: string;
}

export interface SearchContext {
  user: AuthenticatedUser;
  locale: AppLocale;
}

/**
 * What a feature lets the global search look through. The feature registers it once when it starts (like a reminder provider); the search only asks the providers of areas
 * the person may open, so nobody finds what they could not open by clicking.
 */
export interface SearchProvider {
  /** The group the hits come under; also the title of the group in the palette (`navigation.items.<key>`). */
  key: string;
  /** The permission area a person needs (`clients` → `clients.view`). */
  area: string;
  /** Groups are shown in this order. */
  order: number;
  /** `terms` are the folded words of the query (no accents, no capitals); `raw` is what was typed. */
  find(query: { terms: string[]; raw: string }, limit: number, context: SearchContext): Promise<SearchHit[]>;
}
