import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';
import { EXPORT_FORMATS } from '../../../lib/exports/export.types.js';
import { MAX_SUBTASKS, MAX_TAGS, TASK_PRIORITIES, TASK_STATUSES } from '../tasks.constants.js';

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class TaskListQuery extends ListQueryDto {
  /** Only the tasks of the signed-in person. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() mine?: boolean;
  /** One person's tasks, or `none` for the tasks nobody has. */
  @IsOptional() @IsString() @MaxLength(60) assigneeId?: string;
  /** Codes of the `task_status` list, comma separated. */
  @IsOptional() @IsString() @MaxLength(100) status?: string;
  /** Codes of the `task_priority` list, comma separated. */
  @IsOptional() @IsString() @MaxLength(100) priority?: string;
  @IsOptional() @IsString() @MaxLength(40) linkedType?: string;
  @IsOptional() @IsString() @MaxLength(60) linkedId?: string;
  /** The client the task is about — itself, or through the worker, contract, invoice … it is linked to. */
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsString() @MaxLength(60) tag?: string;
  /** `true` = still to do, `false` = done. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() open?: boolean;
  /** `overdue`, `today` or `week` (today and the next seven days). */
  @IsOptional() @IsIn(['overdue', 'today', 'week']) due?: string;
  /** `active` (default), `inactive` (taken away) or `all`. */
  @IsOptional() @IsIn(['active', 'inactive', 'all']) state?: string;
}

export class TaskExportQuery extends TaskListQuery {
  @IsOptional() @IsIn(EXPORT_FORMATS) format?: string;
}

/** One line of a task's little checklist. */
export class SubtaskDto {
  @IsOptional() @IsString() @MaxLength(60) id?: string;
  @IsString() @MaxLength(200) title!: string;
  @IsOptional() @IsBoolean() done?: boolean;
}

export class CreateTaskDto {
  @IsString() @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsIn(TASK_STATUSES) status?: string;
  @IsOptional() @IsIn(TASK_PRIORITIES) priority?: string;
  @IsOptional() @Matches(DAY) dueDate?: string | null;
  /** Without one the task goes to the person who makes it. */
  @IsOptional() @IsString() @MaxLength(60) assigneeId?: string | null;
  @IsOptional() @IsString() @MaxLength(40) linkedType?: string | null;
  @IsOptional() @IsString() @MaxLength(60) linkedId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_TAGS) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_SUBTASKS) @ValidateNested({ each: true }) @Type(() => SubtaskDto) subtasks?: SubtaskDto[];
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsIn(TASK_STATUSES) status?: string;
  @IsOptional() @IsIn(TASK_PRIORITIES) priority?: string;
  @IsOptional() @Matches(DAY) dueDate?: string | null;
  @IsOptional() @IsString() @MaxLength(60) assigneeId?: string | null;
  @IsOptional() @IsString() @MaxLength(40) linkedType?: string | null;
  @IsOptional() @IsString() @MaxLength(60) linkedId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_TAGS) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_SUBTASKS) @ValidateNested({ each: true }) @Type(() => SubtaskDto) subtasks?: SubtaskDto[];
}

/** Takes a task away (it stays for history) or brings it back. */
export class TaskActiveDto {
  @IsBoolean() isActive!: boolean;
}
