import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service.js';

/** The AI provider (OpenAI): reading photos, scans and PDFs, with a budget and a usage log. Imported once, in AppModule. */
@Global()
@Module({ providers: [AiService], exports: [AiService] })
export class AiModule {}
