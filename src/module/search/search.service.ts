import { Injectable, Logger } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import type { SearchHit, SearchProvider } from './search.types.js';

/** The longest query and the number of words that count; a search takes two characters at least. */
const MIN_LENGTH = 2;
const MAX_TERMS = 5;

/**
 * The global search (Ctrl+K): clients, workers, contracts, invoices, documents (by name and by what they say), forms, inspections and tasks. Every feature registers what it
 * can find; one request asks all of them at once and answers with the hits per group — only for the areas the person may open.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly providers = new Map<string, SearchProvider>();

  register(provider: SearchProvider): void {
    this.providers.set(provider.key, provider);
  }

  /** `{ [group]: hits }` for the groups that have hits, in the order of the providers. */
  async search(raw: string | undefined, user: AuthenticatedUser, locale: AppLocale, limit = 5): Promise<Record<string, SearchHit[]>> {
    const text = (raw ?? '').trim();
    if (text.length < MIN_LENGTH) return {};
    const terms = fold(text).split(' ').filter(Boolean).slice(0, MAX_TERMS);
    if (!terms.length) return {};
    const allowed = [...this.providers.values()].filter(provider => matrixAllows(user.matrix, `${provider.area}.view`)).sort((a, b) => a.order - b.order);
    const answers = await Promise.all(
      allowed.map(async provider => {
        try {
          return { key: provider.key, hits: await provider.find({ terms, raw: text }, limit, { user, locale }) };
        } catch (error) {
          // One part that cannot be searched must not take the others down.
          this.logger.warn(`The search of "${provider.key}" failed: ${(error as Error).message.split('\n')[0]}`);
          return { key: provider.key, hits: [] as SearchHit[] };
        }
      }),
    );
    return Object.fromEntries(answers.filter(answer => answer.hits.length).map(answer => [answer.key, answer.hits]));
  }
}
