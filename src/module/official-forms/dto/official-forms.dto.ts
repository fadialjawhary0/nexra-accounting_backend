import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';
import { MAX_MAPPING_ENTRIES, PERIOD_KINDS, SUBJECTS, SUBMISSION_STATUSES } from '../official-forms.constants.js';

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/* ── The library ──────────────────────────────────────────────────────────────────────────────────────────────────── */

export class FormListQuery extends ListQueryDto {
  /** `active` (default), `inactive` or `all`. */
  @IsOptional() @IsIn(['active', 'inactive', 'all']) status?: string;
  @IsOptional() @IsIn(SUBJECTS) subject?: string;
}

export class FormExportQuery extends FormListQuery {
  @IsOptional() @IsString() format?: string;
}

/** What is typed about a form of the library (not its PDF: that is a version). */
export class SaveFormDto {
  /** Only when the form is made: a short name for the program (`melding_loonheffingen`); it never changes. */
  @IsOptional() @Matches(/^[a-z][a-z0-9_]{1,59}$/) code?: string;
  @IsString() @MaxLength(120) nameNl!: string;
  @IsString() @MaxLength(120) nameEn!: string;
  @IsOptional() @IsString() @MaxLength(1000) descriptionNl?: string;
  @IsOptional() @IsString() @MaxLength(1000) descriptionEn?: string;
  /** The code printed on the form ("CPT 158"). */
  @IsOptional() @IsString() @MaxLength(60) authorityCode?: string;
  @IsOptional() @IsString() @MaxLength(300) officialUrl?: string;
  @IsOptional() @IsIn(SUBJECTS) subject?: string;
  @IsOptional() @IsIn(PERIOD_KINDS) periodKind?: string;
  @IsOptional() @IsString() @MaxLength(60) recipientId?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) followUpDays?: number | null;
  @IsOptional() @IsBoolean() warnWhenPending?: boolean;
  /** Code of the document type the filled form is filed as. */
  @IsOptional() @IsString() @MaxLength(40) docType?: string;
  /** Code of the standard folder; empty = the folder of the document type. */
  @IsOptional() @IsString() @MaxLength(40) folderCode?: string | null;
  @IsOptional() @IsString() @MaxLength(120) namePattern?: string;
  @IsOptional() @IsBoolean() flatten?: boolean;
}

export class FormStatusDto {
  @IsBoolean() isActive!: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

/** A new edition of the blank PDF (uploaded with the purpose `form_blank` first). */
export class CreateVersionDto {
  @IsString() @MaxLength(60) fileId!: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  /** Keep what is mapped for the fields that the new edition still has (default: yes). */
  @IsOptional() @IsBoolean() copyMapping?: boolean;
}

export class SaveMappingDto {
  @IsArray() @ArrayMaxSize(MAX_MAPPING_ENTRIES) mapping!: unknown[];
}

/* ── Filling a form in ────────────────────────────────────────────────────────────────────────────────────────────── */

/** Who and what the form is for. */
export class SubjectDto {
  @IsString() @MaxLength(60) clientId!: string;
  /** One of the people of the client (an owner, a director, a partner). */
  @IsOptional() @IsString() @MaxLength(60) personId?: string;
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string;
  @IsOptional() @Matches(DAY) periodStart?: string;
  @IsOptional() @Matches(DAY) periodEnd?: string;
}

export class SubjectsQuery {
  @IsString() @MaxLength(60) clientId!: string;
}

export class PrepareDto extends SubjectDto {
  /** The edition to use (default: the newest). */
  @IsOptional() @IsString() @MaxLength(60) versionId?: string;
  /** For somebody who edits the library: a mapping that is not saved yet, to try it. */
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_MAPPING_ENTRIES) mapping?: unknown[];
  /** Values read from a photo or scan (`client.kvk`: …) — shown as suggestions. */
  @IsOptional() @IsObject() overlay?: Record<string, unknown>;
}

/** The values in the fields of the PDF, by the name of the field in the PDF. */
export class FillValuesDto extends SubjectDto {
  @IsOptional() @IsString() @MaxLength(60) versionId?: string;
  @IsObject() values!: Record<string, unknown>;
  /** For somebody who edits the library: a mapping that is not saved yet. */
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_MAPPING_ENTRIES) mapping?: unknown[];
}

export class SubmitDto extends FillValuesDto {
  /** The address of the envelope (default: the form's own recipient). */
  @IsOptional() @IsString() @MaxLength(60) recipientId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  /** Some of the values came from a photo or scan the AI read. */
  @IsOptional() @IsBoolean() usedAi?: boolean;
  /** The form is posted at once: its status becomes "sent" today. */
  @IsOptional() @IsBoolean() markSent?: boolean;
}

/* ── The log of sent forms ────────────────────────────────────────────────────────────────────────────────────────── */

export class SubmissionListQuery extends ListQueryDto {
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string;
  @IsOptional() @IsString() @MaxLength(60) formId?: string;
  /** Codes of the `form_submission_status` list, comma separated. */
  @IsOptional() @IsString() @MaxLength(80) status?: string;
  /** `active` (default), `inactive` (taken out of the log) or `all`. */
  @IsOptional() @IsIn(['active', 'inactive', 'all']) state?: string;
  /** Only forms that were sent and whose follow-up day has come. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() overdue?: boolean;
  /** The day the form was made, from / to. */
  @IsOptional() @Matches(DAY) from?: string;
  @IsOptional() @Matches(DAY) to?: string;
}

export class SubmissionExportQuery extends SubmissionListQuery {
  @IsOptional() @IsString() format?: string;
}

export class UpdateSubmissionDto {
  @IsOptional() @IsIn(SUBMISSION_STATUSES) status?: string;
  @IsOptional() @Matches(DAY) sentOn?: string | null;
  @IsOptional() @Matches(DAY) doneOn?: string | null;
  @IsOptional() @Matches(DAY) followUpOn?: string | null;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MaxLength(60) recipientId?: string | null;
}

export class SubmissionStatusDto {
  @IsBoolean() isActive!: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
