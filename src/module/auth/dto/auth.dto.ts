import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Locale codes the app and its e-mails support. */
export const LOCALES = ['nl', 'en'] as const;

export class LoginDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @IsNotEmpty() @MaxLength(200) password!: string;
}

export class TwoFactorLoginDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) challenge!: string;
  /** The 6 digits from the authenticator app… */
  @IsOptional() @IsString() @MaxLength(20) code?: string;
  /** …or one of the recovery codes. */
  @IsOptional() @IsString() @MaxLength(40) recoveryCode?: string;
}

export class ForgotPasswordDto {
  @IsEmail() @MaxLength(254) email!: string;
}

export class TokenDto {
  @IsString() @IsNotEmpty() @MaxLength(200) token!: string;
}

/** Choosing a password from an e-mailed link (reset or invitation). */
export class SetPasswordDto extends TokenDto {
  @IsString() @IsNotEmpty() @MaxLength(200) password!: string;
  @IsOptional() @IsString() @MaxLength(200) confirm?: string;
}

export class ChangePasswordDto {
  @IsString() @IsNotEmpty() @MaxLength(200) current!: string;
  @IsString() @IsNotEmpty() @MaxLength(200) next!: string;
  @IsOptional() @IsString() @MaxLength(200) confirm?: string;
}

export class UpdateProfileDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsIn(LOCALES) locale?: string;
}

export class TwoFactorCodeDto {
  @IsString() @IsNotEmpty() @MaxLength(20) code!: string;
}

/** Sensitive actions on your own account ask for the password again. */
export class PasswordConfirmDto {
  @IsString() @IsNotEmpty() @MaxLength(200) password!: string;
}
