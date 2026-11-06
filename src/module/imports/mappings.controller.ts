import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { MappingListQuery, SaveMappingDto, UpdateMappingDto } from './dto/imports.dto.js';
import { MappingsService } from './mappings.service.js';
import { DeletionService } from '../deletion/deletion.service.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';

/** The saved column layouts of spreadsheets (Settings → Import). Declared before the imports controller so `/imports/mappings` is not taken for an import id. */
@Controller('imports/mappings')
@RequirePermission('imports.view')
export class MappingsController {
  constructor(
    private readonly mappings: MappingsService,
    private readonly deletion: DeletionService,
  ) {}

  @Get()
  list(@Query() query: MappingListQuery) {
    return this.mappings.list(query.target);
  }

  @RequirePermission('imports.edit')
  @Post()
  create(@Body() dto: SaveMappingDto, @CurrentUser('id') userId: string) {
    return this.mappings.create(dto, userId);
  }

  @RequirePermission('imports.edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateMappingDto) {
    return this.mappings.update(id, dto);
  }

  /** Deletes a saved column layout (soft). */
  @RequirePermission('imports.remove')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.deletion.delete('import_mapping', id, user);
  }
}
