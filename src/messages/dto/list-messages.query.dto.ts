import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_MESSAGES_LIMIT = 30;

export class ListMessagesQueryDto {
  /** Oldest already-seen sequence number -- omit for the newest page. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class SyncMessagesQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSequence!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
