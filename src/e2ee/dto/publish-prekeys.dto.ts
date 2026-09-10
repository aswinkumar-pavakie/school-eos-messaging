import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';

class SignedPrekeyDto {
  @IsString()
  @MinLength(1)
  publicKey!: string;

  @IsString()
  @MinLength(1)
  signature!: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class PublishPrekeysDto {
  @IsUUID()
  deviceId!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  identityPublicKey?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SignedPrekeyDto)
  signedPrekey?: SignedPrekeyDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  oneTimePrekeys?: string[];
}
