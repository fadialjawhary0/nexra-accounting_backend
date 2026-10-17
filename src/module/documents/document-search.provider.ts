import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SearchService } from '../search/search.service.js';
import type { SearchContext, SearchHit } from '../search/search.types.js';
import { DocumentsService } from './documents.service.js';
import type { DocumentListQuery } from './dto/documents.dto.js';

/**
 * The documents, by name, client, worker, type and by what they say. It asks the Documents page's own list, so a person only finds the documents they could open there
 * (what a document is about decides who may see it).
 */
@Injectable()
export class DocumentSearchProvider implements OnModuleInit {
  constructor(
    private readonly documents: DocumentsService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    this.search.register({ key: 'documents', area: 'documents', order: 50, find: (query, limit, context) => this.find(query.raw, limit, context) });
  }

  private async find(raw: string, limit: number, context: SearchContext): Promise<SearchHit[]> {
    const result = await this.documents.list({ search: raw, page: 1, pageSize: limit } as DocumentListQuery, context.user, context.locale);
    const rows = result.data as Array<{ id: string; name: string; type: { name: string } | null; client: { number: string; name: string } | null; person: { name: string } | null; snippet?: string }>;
    return rows.map(row => ({
      id: row.id,
      title: row.name,
      subtitle: [row.client ? `${row.client.number} – ${row.client.name}` : '', row.person?.name ?? '', row.type?.name ?? ''].filter(Boolean).join(' · '),
      href: `/documents?open=${row.id}`,
      ...(row.snippet && { snippet: row.snippet }),
    }));
  }
}
