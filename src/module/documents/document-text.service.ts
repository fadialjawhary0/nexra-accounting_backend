import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { fold } from '../../common/text.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentReaderService } from '../../lib/documents/document-reader.service.js';
import { QueueProcessor, QueueWorker } from '../../lib/queue/queue.decorator.js';
import { QueueService } from '../../lib/queue/queue.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { DOCUMENT_INDEX_QUEUE, DOCUMENT_PURPOSES, extensionOf } from '../files/files.constants.js';
import { FilesService } from '../files/files.service.js';
import { INDEX_BACKFILL_BATCH, MAX_TEXT_CHARACTERS } from './documents.constants.js';

/**
 * Reading the text of documents so they can be found by what they say. Every new document is put on the queue by the files service; one job reads one
 * file (the text layer of a PDF, a Word, Excel or OpenDocument file, plain text). A scan or a photo has no text to read — it is marked as such and
 * found by its name, type and links instead. Documents that were there before the search existed are picked up, a batch at a time, each time the queue
 * starts.
 */
@QueueProcessor()
@Injectable()
export class DocumentTextService implements OnModuleInit {
  private readonly logger = new Logger(DocumentTextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly reader: DocumentReaderService,
    private readonly queue: QueueService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.queue.onReady(() => this.backfill());
  }

  @QueueWorker({ queue: DOCUMENT_INDEX_QUEUE, retryLimit: 2, retryDelaySeconds: 60, expireSeconds: 300, concurrency: 1 })
  async handle(payload: { fileId?: string }): Promise<void> {
    if (payload.fileId) await this.read(payload.fileId);
  }

  /** Reads one file and stores what was found (also "nothing"), so it is not read again. */
  async read(fileId: string): Promise<void> {
    if (!this.settings.get<boolean>('documents.indexText')) return;
    const file = await this.prisma.storedFile.findUnique({ where: { id: fileId }, select: { id: true, name: true, isActive: true, purpose: true } });
    if (!file || !file.isActive || !DOCUMENT_PURPOSES.includes(file.purpose)) return;
    let status = 'failed';
    let text = '';
    let pages: number | null = null;
    try {
      const { buffer } = await this.files.bytes(fileId);
      const result = await this.reader.readForSearch(buffer, extensionOf(file.name));
      status = result.status;
      text = result.text.slice(0, MAX_TEXT_CHARACTERS);
      pages = result.pages;
    } catch (error) {
      // A file that cannot be read now will not be readable on a second try either: it is marked, and a person can ask for it to be read again.
      this.logger.warn(`The text of ${file.name} could not be read: ${(error as Error).message.split('\n')[0]}`);
    }
    const searchText = text ? fold(text).slice(0, MAX_TEXT_CHARACTERS) : '';
    await this.prisma.documentText.upsert({
      where: { fileId },
      create: { fileId, status, content: text, searchText, pages },
      update: { status, content: text, searchText, pages, extractedAt: new Date() },
    });
  }

  /** Documents without a read text yet: they are put on the queue (a batch each time; the next start takes the next batch). */
  private async backfill(): Promise<void> {
    if (!this.settings.get<boolean>('documents.indexText')) return;
    const missing = await this.prisma.storedFile.findMany({ where: { isActive: true, purpose: { in: [...DOCUMENT_PURPOSES] }, text: { is: null } }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: INDEX_BACKFILL_BATCH });
    for (const file of missing) await this.queue.send(DOCUMENT_INDEX_QUEUE, { fileId: file.id }, { singletonKey: file.id });
    if (missing.length) this.logger.log(`${missing.length} documents are being read for the search.`);
  }

  /** Reads a document again (after the office switched the search on, or when the first try failed). */
  async reindex(fileId: string): Promise<void> {
    await this.queue.send(DOCUMENT_INDEX_QUEUE, { fileId }, { singletonKey: fileId });
  }
}
