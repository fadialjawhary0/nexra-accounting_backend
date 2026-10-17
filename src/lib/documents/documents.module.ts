import { Global, Module } from '@nestjs/common';
import { DocumentReaderService } from './document-reader.service.js';
import { DocumentsService } from './documents.service.js';

/** Word templates with merge fields, Word → PDF, and reading the text of files. Imported once, in AppModule. */
@Global()
@Module({ providers: [DocumentsService, DocumentReaderService], exports: [DocumentsService, DocumentReaderService] })
export class DocumentsModule {}
