import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';
import { EXPORT_FORMATS } from '../../../lib/exports/export.types.js';
import { HANDOVER_METHODS, INSPECTION_STATUSES, ITEM_DECISIONS, MAX_REQUEST_CHARACTERS } from '../inspections.constants.js';

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What the list of inspections can be narrowed by. Codes of lists are comma separated. */
export class InspectionListQuery extends ListQueryDto {
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsString() @MaxLength(200) status?: string;
  @IsOptional() @IsString() @MaxLength(200) type?: string;
  @IsOptional() @IsString() @MaxLength(200) body?: string;
  @IsOptional() @IsString() @MaxLength(60) assigneeId?: string;
  /** The day of the inspection, from / to (`YYYY-MM-DD`). */
  @IsOptional() @Matches(DAY) from?: string;
  @IsOptional() @Matches(DAY) to?: string;
  /** Only inspections that are not over (planned, going on, waiting for the result). */
  @IsOptional() @Transform(toBoolean) @IsBoolean() open?: boolean;
  /** Only open inspections that are within this many days (`30`: the next month). */
  @IsOptional() @Matches(/^\d{1,3}$/) within?: string;
  /** `active` (default), `inactive` or `all`. */
  @IsOptional() @IsIn(['active', 'inactive', 'all']) state?: string;
}

export class InspectionExportQuery extends InspectionListQuery {
  @IsOptional() @IsIn(EXPORT_FORMATS) format?: string;
}

/** A client's readiness for an inspection (the readiness view). */
export class ReadinessQuery extends ListQueryDto {
  /** `relevant` (default): clients with an inspection that is not over, and the clients marked as NEN 4400-1 certified; `all`: every active client. */
  @IsOptional() @IsIn(['relevant', 'all']) show?: string;
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  /** Only clients that are not fully ready. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() attention?: boolean;
}

export class ReadinessExportQuery extends ReadinessQuery {
  @IsOptional() @IsIn(EXPORT_FORMATS) format?: string;
}

export class CreateInspectionDto {
  @IsString() @MaxLength(60) clientId!: string;
  /** Code of the `inspection_type` list. */
  @IsString() @MaxLength(40) type!: string;
  /** Code of the `inspection_body` list. */
  @IsString() @MaxLength(40) body!: string;
  @Matches(DAY) date!: string;
  @IsOptional() @IsString() @MaxLength(120) inspectorName?: string;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @IsOptional() @Matches(DAY) periodFrom?: string | null;
  @IsOptional() @Matches(DAY) periodTo?: string | null;
  @IsOptional() @Matches(DAY) responseDue?: string | null;
  /** The edition of the checklist; by default the newest published one of the checklist for this kind of inspection. */
  @IsOptional() @IsString() @MaxLength(60) versionId?: string | null;
  @IsOptional() @IsString() @MaxLength(60) assigneeId?: string | null;
  @IsOptional() @IsString() @MaxLength(MAX_REQUEST_CHARACTERS) requestText?: string;
  /** Make the dated folder (default: Settings → Inspections). */
  @IsOptional() @Transform(toBoolean) @IsBoolean() createFolder?: boolean;
}

export class UpdateInspectionDto {
  @IsOptional() @IsString() @MaxLength(40) type?: string;
  @IsOptional() @IsString() @MaxLength(40) body?: string;
  @IsOptional() @Matches(DAY) date?: string;
  @IsOptional() @IsString() @MaxLength(120) inspectorName?: string;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @IsOptional() @Matches(DAY) periodFrom?: string | null;
  @IsOptional() @Matches(DAY) periodTo?: string | null;
  @IsOptional() @Matches(DAY) responseDue?: string | null;
  @IsOptional() @IsString() @MaxLength(60) versionId?: string | null;
  @IsOptional() @IsString() @MaxLength(60) assigneeId?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) findings?: string;
  @IsOptional() @IsString() @MaxLength(MAX_REQUEST_CHARACTERS) requestText?: string;
}

/** Moves an inspection on: `closed` needs the outcome and takes the checklist as it stands. */
export class InspectionStatusDto {
  @IsIn(INSPECTION_STATUSES) status!: string;
  /** Code of the `inspection_outcome` list (when closing). */
  @IsOptional() @IsString() @MaxLength(40) outcome?: string | null;
  @IsOptional() @Matches(DAY) closedOn?: string;
  @IsOptional() @IsString() @MaxLength(4000) findings?: string;
  /** Plan the next inspection of a recurring kind (default: Settings → Inspections). */
  @IsOptional() @Transform(toBoolean) @IsBoolean() planNext?: boolean;
}

export class InspectionActiveDto {
  @IsBoolean() isActive!: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class PlanNextDto {
  @IsOptional() @Matches(DAY) date?: string;
}

/** What is decided about a line of the checklist: not applicable, or done; a note; the inspector's own deadline. */
export class ItemDecisionDto {
  @IsOptional() @IsIn([...ITEM_DECISIONS, null]) decision?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @Matches(DAY) dueDate?: string | null;
}

/** Switches lines of the checklist on (the inspector asks for them this time) or off — one line, or all lines of a part at once. */
export class SwitchLinesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @IsString({ each: true }) @MaxLength(20, { each: true }) codes!: string[];
  @Transform(toBoolean) @IsBoolean() on!: boolean;
}

/** A document put on a line by hand (`added`) or taken off it (`excluded`); `null` forgets the choice. */
export class ItemFileDto {
  @IsString() @MaxLength(60) fileId!: string;
  @IsIn(['added', 'excluded', 'none']) kind!: string;
}

export class CustomItemDto {
  @IsOptional() @IsString() @MaxLength(240) label?: string;
  @IsOptional() @IsIn([...ITEM_DECISIONS, null]) decision?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @Matches(DAY) dueDate?: string | null;
}

export class FollowUpDto {
  @IsOptional() @IsString() @MaxLength(500) text?: string;
  @IsOptional() @Matches(DAY) dueDate?: string | null;
  @IsOptional() @Matches(DAY) doneOn?: string | null;
  @IsOptional() @IsString() @MaxLength(60) assigneeId?: string | null;
}

/** Writes down that something was handed over (shown on site, sent by e-mail …) without making a bundle. */
export class HandoverDto {
  @IsIn(HANDOVER_METHODS) method!: string;
  @IsString() @MaxLength(120) toName!: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  /** The lines that were handed over; empty = all lines that are ready. */
  @IsOptional() @IsArray() @ArrayMaxSize(300) @IsString({ each: true }) codes?: string[];
}

/** Makes the bundle for the inspector: which lines, in which format, to whom. */
export class BundleDto {
  @IsIn(['zip', 'pdf']) format!: string;
  /** The lines to put in; empty = every line that has documents. */
  @IsOptional() @IsArray() @ArrayMaxSize(300) @IsString({ each: true }) codes?: string[];
  /** The person making it has seen the warning about citizen service numbers and hands the documents over anyway. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() acceptBsn?: boolean;
  /** Add the checklist (Excel) to a ZIP. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() includeChecklist?: boolean;
  @IsOptional() @IsString() @MaxLength(120) toName?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** What is about to be put in a bundle (the same choices, to see the warnings first). */
export class BundleCheckDto {
  @IsOptional() @IsArray() @ArrayMaxSize(300) @IsString({ each: true }) codes?: string[];
}

export class RequestTextDto {
  @IsOptional() @IsString() @MaxLength(MAX_REQUEST_CHARACTERS) text?: string;
}

/** What a person confirmed of the AI's reading of a request: the lines it names and the facts. */
export class RequestApplyDto {
  /** `[{ code, text, dueDate }]` — `code` of a line of the checklist, or null for a line the checklist does not have (taken in as a line of its own). */
  @IsArray() @ArrayMaxSize(100) lines!: Array<{ code?: string | null; text?: string; dueDate?: string | null }>;
  @IsOptional() @IsString() @MaxLength(120) inspectorName?: string;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @IsOptional() @Matches(DAY) responseDue?: string | null;
  /** Lines of the checklist the inspector did not ask for are marked "not applicable". */
  @IsOptional() @Transform(toBoolean) @IsBoolean() markOthers?: boolean;
  @IsOptional() @IsString() @MaxLength(MAX_REQUEST_CHARACTERS) requestText?: string;
}

export class ChecklistExportQuery {
  @IsOptional() @IsIn(EXPORT_FORMATS) format?: string;
}
