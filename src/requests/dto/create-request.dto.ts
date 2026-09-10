import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';

class InitialMessageDto {
  @IsUUID()
  clientMessageId!: string;

  @IsString()
  @MinLength(1)
  ciphertext!: string;

  @IsString()
  @MinLength(1)
  encryptionVersion!: string;

  @IsOptional()
  @IsObject()
  encryptionHeader?: Record<string, unknown>;
}

export class CreateRequestDto {
  @IsUUID()
  targetPersonId!: string;

  /** Mandatory here (unlike CreateConversationDto's own optional one) — LLD
   * §16/§30: a request is inseparable from its one initial message. */
  @ValidateNested()
  @Type(() => InitialMessageDto)
  initialMessage!: InitialMessageDto;
}
