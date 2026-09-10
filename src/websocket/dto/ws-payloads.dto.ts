import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
} from 'class-validator';

export class MessageSendPayload {
  @IsUUID()
  conversationId!: string;

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

export class ConversationReadPayload {
  @IsUUID()
  conversationId!: string;

  @IsInt()
  @Min(0)
  sequence!: number;
}

export class TypingPayload {
  @IsUUID()
  conversationId!: string;
}

export class RequestDecisionPayload {
  @IsUUID()
  requestId!: string;
}

export class SyncRequestPayload {
  @IsUUID()
  conversationId!: string;

  @IsInt()
  @Min(0)
  afterSequence!: number;
}
