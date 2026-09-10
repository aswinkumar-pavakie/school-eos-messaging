import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';

export class SendMessageDto {
  @IsUUID()
  clientMessageId!: string;

  /** Base64-encoded ciphertext -- this service never sees plaintext (LLD §9,
   * §19, §22). Decoded to a Buffer at the controller boundary. */
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
