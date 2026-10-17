import { Global, Module } from '@nestjs/common';
import { PdfService } from './pdf.service.js';

/** Reads, fills and draws PDF files (the official forms of the tax office, envelope labels). Infrastructure: imported once, in `AppModule`. */
@Global()
@Module({
  providers: [PdfService],
  exports: [PdfService],
})
export class PdfModule {}
