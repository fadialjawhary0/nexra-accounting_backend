import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { FormDoc } from './form-doc.js';
import { FormValidationService } from './form-validation.service.js';
import { FormsService } from './forms.service.js';

class PublishDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class TryDto {
  @IsObject() values!: Record<string, unknown>;
  @IsOptional() @IsObject() existing?: Record<string, unknown>;
  /** Check against the unpublished draft instead of the live form. */
  @IsOptional() @IsBoolean() draft?: boolean;
}

/**
 * Settings → Forms. The form builder works on a draft; publishing makes it the form everyone fills in. The people who fill in forms
 * read the live definition (`GET /forms/:entity/live`), which needs access to the records themselves.
 */
@Controller('forms')
export class FormsController {
  constructor(
    private readonly forms: FormsService,
    private readonly validation: FormValidationService,
  ) {}

  @RequirePermission('settings.view')
  @Get()
  overview() {
    return this.forms.overview();
  }

  /** The published form for rendering — fields the signed-in person may not see are left out. */
  @Get(':entity/live')
  live(@Param('entity') entity: string, @CurrentUser() user: AuthenticatedUser) {
    return this.forms.liveFor(entity, user);
  }

  @RequirePermission('settings.view')
  @Get(':entity')
  builder(@Param('entity') entity: string) {
    return this.forms.builder(entity);
  }

  @RequirePermission('settings.edit')
  @Put(':entity/draft')
  saveDraft(@Param('entity') entity: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.forms.saveDraft(entity, body, user);
  }

  @RequirePermission('settings.edit')
  @Delete(':entity/draft')
  discardDraft(@Param('entity') entity: string) {
    return this.forms.discardDraft(entity);
  }

  @RequirePermission('settings.edit')
  @Post(':entity/publish')
  publish(@Param('entity') entity: string, @Body() dto: PublishDto, @CurrentUser() user: AuthenticatedUser) {
    return this.forms.publish(entity, dto.note?.trim() ?? '', user);
  }

  @RequirePermission('settings.view')
  @Get(':entity/revisions')
  revisions(@Param('entity') entity: string) {
    return this.forms.revisions(entity);
  }

  @RequirePermission('settings.edit')
  @Post(':entity/revisions/:revision/restore')
  restore(@Param('entity') entity: string, @Param('revision', ParseIntPipe) revision: number, @CurrentUser() user: AuthenticatedUser) {
    return this.forms.restore(entity, revision, user);
  }

  /** "Try it": checks sample values against the live or the draft form and shows what would be saved — nothing is stored. */
  @RequirePermission('settings.edit')
  @Post(':entity/try')
  async tryValues(@Param('entity') entity: string, @Body() dto: TryDto, @CurrentUser() user: AuthenticatedUser) {
    const doc: FormDoc | undefined = dto.draft ? await this.forms.workingDoc(entity) : undefined;
    return this.validation.check(entity, dto.values, dto.existing ?? {}, user.matrix, doc);
  }
}
