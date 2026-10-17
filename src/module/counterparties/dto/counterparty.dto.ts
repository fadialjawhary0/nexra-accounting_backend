import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';

/** The `counterparty` form: the company's name, KvK and VAT number, address, contact and bank. */
export class SaveCounterpartyDto {
  @IsObject() values!: Record<string, unknown>;
}

export class CounterpartyStatusDto {
  @IsBoolean() isActive!: boolean;
  /** Why a company is switched off (kept with it). */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class CounterpartyListQuery extends ListQueryDto {
  /** `active` (default), `inactive` or `all`. */
  @IsOptional() @IsIn(['active', 'inactive', 'all']) status?: 'active' | 'inactive' | 'all';
}

export class CounterpartyExportQuery extends CounterpartyListQuery {
  @IsOptional() @IsString() @MaxLength(10) format?: string;
}
