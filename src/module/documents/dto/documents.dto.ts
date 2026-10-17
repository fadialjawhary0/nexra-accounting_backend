import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';
import { LINK_TYPE_KEYS } from '../documents.constants.js';

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What the list of documents can be narrowed by. */
export class DocumentListQuery extends ListQueryDto {
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  /** A worker: their documents, including the copies on the person's record. */
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string;
  /** A folder of the client — and the folders inside it, unless `subfolders=false`. */
  @IsOptional() @IsString() @MaxLength(60) folderId?: string;
  @IsOptional() @Transform(toBoolean) @IsBoolean() subfolders?: boolean;
  /** Codes of document types, comma separated. */
  @IsOptional() @IsString() @MaxLength(400) type?: string;
  /** `valid`, `expiring`, `expired`, `none` (no end date), comma separated. */
  @IsOptional() @IsString() @MaxLength(60) status?: string;
  /** `client` (documents of the company) or `worker` (of a person). */
  @IsOptional() @IsIn(['client', 'worker']) scope?: string;
  /** The date on the document, from / to (`YYYY-MM-DD`). */
  @IsOptional() @Matches(DAY) from?: string;
  @IsOptional() @Matches(DAY) to?: string;
  /** `current` (default): the latest version of each document; `all`: every version. */
  @IsOptional() @IsIn(['current', 'all']) versions?: string;
  /** `active` (default), `inactive` (the removed ones) or `all`. */
  @IsOptional() @IsIn(['active', 'inactive', 'all']) state?: string;
  /** Only documents without a type. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() untyped?: boolean;
  /** Documents that are also linked to this record. */
  @IsOptional() @IsIn(LINK_TYPE_KEYS) linkType?: string;
  @IsOptional() @IsString() @MaxLength(60) linkId?: string;
}

export class DocumentExportQuery extends DocumentListQuery {
  @IsOptional() @IsString() format?: string;
}

/** The documents that have to be there (or are about to expire). */
export class RequirementQuery extends ListQueryDto {
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string;
  /** `missing`, `expired`, `expiring`, `ok`, comma separated; default: everything that needs attention. */
  @IsOptional() @IsString() @MaxLength(60) state?: string;
  @IsOptional() @IsIn(['client', 'worker']) scope?: string;
  @IsOptional() @IsString() @MaxLength(400) type?: string;
}

export class RequirementExportQuery extends RequirementQuery {
  @IsOptional() @IsString() format?: string;
}

/** The clients with how many documents they have and what is missing (the rail of the page). */
export class OverviewQuery extends ListQueryDto {
  /** `all` (default), `attention` (something missing or expiring). */
  @IsOptional() @IsIn(['all', 'attention']) show?: string;
}

/** What is known about files that are about to be uploaded: the type their name points to and the date in it. */
export class SuggestDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(300, { each: true }) names!: string[];
}

/** The metadata of one uploaded file (multipart fields next to `file`). */
export class UploadDocumentDto {
  /** The client the document is for. */
  @IsOptional() @IsString() @MaxLength(60) clientId?: string;
  /** The worker it is for (documents of a person, filed in the worker's own folder). */
  @IsOptional() @IsString() @MaxLength(60) employeeId?: string;
  @IsOptional() @IsString() @MaxLength(60) folderId?: string;
  @IsOptional() @IsString() @MaxLength(40) docType?: string;
  @IsOptional() @Matches(DAY) docDate?: string;
  @IsOptional() @Matches(DAY) validUntil?: string;
  /** The stretch of time the document is about (`YYYY-MM-DD`), when it is about one: a VAT return of a quarter, a statement of a month. */
  @IsOptional() @Matches(DAY) periodFrom?: string;
  @IsOptional() @Matches(DAY) periodTo?: string;
  /** The name to give the file (with its extension); empty = the name of the type's pattern, else the file's own. */
  @IsOptional() @IsString() @MaxLength(180) name?: string;
  /** Name the file by the pattern of its type (default: the office setting). */
  @IsOptional() @Transform(toBoolean) @IsBoolean() autoName?: boolean;
  /** The file is the next version of this document. */
  @IsOptional() @IsString() @MaxLength(60) replaces?: string;
  /** The same file may be in the documents twice. */
  @IsOptional() @Transform(toBoolean) @IsBoolean() allowDuplicate?: boolean;
}

export class UpdateDocumentDto {
  @IsOptional() @IsString() @MaxLength(180) name?: string;
  @IsOptional() @IsString() @MaxLength(40) docType?: string | null;
  @IsOptional() @IsString() docDate?: string | null;
  @IsOptional() @IsString() validUntil?: string | null;
  @IsOptional() @IsString() periodFrom?: string | null;
  @IsOptional() @IsString() periodTo?: string | null;
  @IsOptional() @IsString() @MaxLength(60) folderId?: string | null;
}

export class LinkDto {
  @IsIn(LINK_TYPE_KEYS) entityType!: string;
  @IsString() @MaxLength(60) entityId!: string;
}
