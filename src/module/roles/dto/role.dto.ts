import { IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateRoleDto {
  @IsString() @IsNotEmpty() @MaxLength(40) name!: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  /** Key of the role whose permissions are copied. */
  @IsOptional() @IsString() @MaxLength(60) basedOn?: string;
}

export class UpdateRoleDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) name?: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  /** `{ area: [actions] }` — unknown areas and actions are dropped. */
  @IsOptional() @IsObject() permissions?: Record<string, string[]>;
  @IsOptional() @IsBoolean() requireTwoFactor?: boolean;
}
