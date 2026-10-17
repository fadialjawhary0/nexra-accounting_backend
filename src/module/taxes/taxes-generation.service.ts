import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TaxReturnsService } from './tax-returns.service.js';
import { VatPeriodsService } from './vat-periods.service.js';

/**
 * Makes the rows the office would otherwise make by hand: the VAT rows of the quarter that is being filed and of the one that is running (for every active client with a VAT
 * duty), and the returns of the year that just ended (for every client with income tax / corporate tax switched on). It runs every night and once at start-up, only creates what
 * is missing and can be switched off in Settings → Taxes.
 */
@Injectable()
export class TaxesGenerationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TaxesGenerationService.name);

  constructor(
    private readonly vat: VatPeriodsService,
    private readonly returns: TaxReturnsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run().catch(error => this.logger.warn(`The tax rows could not be made at start-up: ${(error as Error).message}`));
  }

  @Cron('30 3 * * *', { timeZone: 'Europe/Amsterdam' })
  async nightly(): Promise<void> {
    await this.run().catch(error => this.logger.error(`The tax rows could not be made: ${(error as Error).message}`));
  }

  async run(): Promise<{ vat: number; returns: number }> {
    const vat = await this.vat.ensureCurrent();
    const returns = await this.returns.generateDefault();
    if (vat || returns) this.logger.log(`Made ${vat} VAT row(s) and ${returns} yearly return(s).`);
    return { vat, returns };
  }
}
