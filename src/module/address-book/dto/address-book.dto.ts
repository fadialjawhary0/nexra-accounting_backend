import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';
import { BOX_KINDS, LABEL_SIZE_KEYS } from '../address-book.constants.js';

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);

export class AddressListQuery extends ListQueryDto {
  /** Code of the `address_category` list. */
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  /** `active` (default), `inactive` or `all`. */
  @IsOptional() @IsIn(['active', 'inactive', 'all']) status?: string;
}

export class AddressExportQuery extends AddressListQuery {
  @IsOptional() @IsString() format?: string;
}

/** What is typed in the address form. Empty text is allowed for everything but the name; the service checks the combinations (a box or a street). */
export class SaveAddressDto {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(120) department?: string;
  @IsOptional() @IsString() @MaxLength(120) street?: string;
  @IsOptional() @IsString() @MaxLength(10) houseNumber?: string;
  @IsOptional() @IsString() @MaxLength(10) houseNumberSuffix?: string;
  @IsOptional() @IsString() @MaxLength(20) box?: string;
  @IsOptional() @IsIn(BOX_KINDS) boxKind?: string;
  @IsOptional() @IsString() @MaxLength(12) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  /** ISO 3166 country code, two letters. */
  @IsOptional() @Matches(/^[A-Za-z]{2}$/) country?: string;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class AddressStatusDto {
  @IsBoolean() isActive!: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class LabelQuery {
  @IsOptional() @IsIn(LABEL_SIZE_KEYS) size?: string;
  /** Print the office's own address in the corner (default: the setting). */
  @IsOptional() @Transform(toBoolean) @IsBoolean() sender?: boolean;
  @IsOptional() @IsIn(['1']) download?: string;
}
