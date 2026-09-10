import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export const DEFAULT_CONVERSATIONS_LIMIT = 30;

export class ListConversationsQueryDto {
  @IsOptional()
  @IsDateString()
  cursorUpdatedAt?: string;

  @IsOptional()
  @IsUUID()
  cursorId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
