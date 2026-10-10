import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** GET /api/health — open to everybody (load balancers, uptime checks). */
  @Public()
  @Get()
  check() {
    return this.health.check();
  }
}
