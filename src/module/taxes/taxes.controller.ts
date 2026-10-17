import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { TaxesAttentionService } from './taxes-attention.service.js';

/** What needs attention in the taxes (the counters on the tabs and, later, the dashboard). */
@Controller('taxes')
@RequirePermission('taxes.view')
export class TaxesController {
  constructor(private readonly attention: TaxesAttentionService) {}

  @Get('attention')
  summary() {
    return this.attention.summary();
  }
}
