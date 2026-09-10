import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class InitialMessageDto {
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

export class CreateConversationDto {
  @IsUUID()
  targetPersonId!: string;

  /** Required when the resolved decision turns out to be REQUIRE_REQUEST
   * (LLD §16/§30) -- optional for an ALLOW_DIRECT conversation, which may
   * legitimately be created with no message yet ("open a chat, then type").
   * The service enforces which case actually applies; the DTO can't know in
   * advance which path the authorization engine will resolve to. */
  @IsOptional()
  @ValidateNested()
  @Type(() => InitialMessageDto)
  initialMessage?: InitialMessageDto;
}
