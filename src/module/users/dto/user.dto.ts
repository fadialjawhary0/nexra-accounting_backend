import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto.js';
import { LOCALES } from '../../auth/dto/auth.dto.js';

const toBoolean = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value);

/** `GET /users?search=&role=medewerker,owner&status=active&twoFactor=true&sort=name:asc&stats=true` */
export class UserListQuery extends ListQueryDto {
  /** One role key, or several separated by commas. */
  @IsOptional() @IsString() @MaxLength(200) role?: string;
  /** `active` · `invited` · `disabled`, comma-separated for more than one. */
  @IsOptional() @IsString() @MaxLength(60) status?: string;
  @IsOptional() @Transform(toBoolean) @IsBoolean() twoFactor?: boolean;
}

export class InviteUserDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) roleKey!: string;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  /** Language of the invitation e-mail and of their first screen. */
  @IsOptional() @IsIn(LOCALES) locale?: string;
  /** `{ area: { add?: [actions], remove?: [actions] } }` — their own changes on top of the role. */
  @IsOptional() @IsObject() permissionOverrides?: Record<string, { add?: string[]; remove?: string[] }>;
  /** Makes two-step verification mandatory for this person. */
  @IsOptional() @IsBoolean() twoFactorRequired?: boolean;
}

/** Every field is optional so `PUT` (whole form) and `PATCH` (one field) share it. */
export class UpdateUserDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) roleKey?: string;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsIn(LOCALES) locale?: string;
  @IsOptional() @IsObject() permissionOverrides?: Record<string, { add?: string[]; remove?: string[] }>;
  /** Makes two-step verification mandatory for this person. */
  @IsOptional() @IsBoolean() twoFactorRequired?: boolean;
}

export class SetUserStatusDto {
  @IsIn(['active', 'disabled']) status!: 'active' | 'disabled';
}
