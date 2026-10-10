import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { NumberingService } from './numbering.service.js';

class UpdateSequenceDto {
  @IsOptional() @IsString() @MaxLength(40) prefix?: string;
  @IsOptional() @IsInt() padding?: number;
  @IsOptional() @IsInt() next?: number;
}

/** Settings → Numbering. */
@Controller('numbering')
export class NumberingController {
  constructor(private readonly numbering: NumberingService) {}

  @RequirePermission('settings.view')
  @Get()
  list() {
    return this.numbering.list();
  }

  @RequirePermission('settings.edit')
  @Put(':key')
  update(@Param('key') key: string, @Body() dto: UpdateSequenceDto, @CurrentUser('id') actorId: string) {
    return this.numbering.configure(key, dto, actorId);
  }
}
