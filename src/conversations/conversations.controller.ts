import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentActor } from '../auth/current-actor.decorator';
import { MESSAGING_ERRORS } from '../common/errors/error-codes';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import {
  DEFAULT_CONVERSATIONS_LIMIT,
  ListConversationsQueryDto,
} from './dto/list-conversations.query.dto';

const CONVERSATION_CREATE_LIMIT_PER_HOUR = 20;

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  async list(
    @Query() query: ListConversationsQueryDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const limit = query.limit ?? DEFAULT_CONVERSATIONS_LIMIT;
    const cursor =
      query.cursorUpdatedAt && query.cursorId
        ? { updatedAt: query.cursorUpdatedAt, id: query.cursorId }
        : undefined;
    const items = await this.conversationsService.list(
      actor.personId,
      cursor,
      limit,
    );
    const last = items[items.length - 1];
    return {
      data: items,
      nextCursor:
        items.length === limit && last
          ? { updatedAt: last.updatedAt, id: last.id }
          : null,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateConversationDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const allowed = await this.rateLimit.consume(
      'conversation-create',
      actor.personId,
      CONVERSATION_CREATE_LIMIT_PER_HOUR,
      3600,
    );
    if (!allowed)
      throw new ForbiddenException({ code: MESSAGING_ERRORS.RATE_LIMITED });

    let ciphertext: Buffer | undefined;
    if (dto.initialMessage) {
      ciphertext = decodeCiphertext(dto.initialMessage.ciphertext);
    }

    const result = await this.conversationsService.createDirect({
      actorPersonId: actor.personId,
      actorRoles: actor.roles,
      targetPersonId: dto.targetPersonId,
      initialMessage: dto.initialMessage
        ? {
            clientMessageId: dto.initialMessage.clientMessageId,
            ciphertext: ciphertext!,
            encryptionVersion: dto.initialMessage.encryptionVersion,
            encryptionHeader: dto.initialMessage.encryptionHeader ?? {},
          }
        : undefined,
    });
    return { data: result };
  }

  @Get(':id')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const conversation = await this.conversationsService.getById(
      id,
      actor.personId,
    );
    return { data: conversation };
  }
}

/** Base64-decodes ciphertext at the REST boundary -- the DTO itself only
 * validates it's a non-empty string. Buffer.from('base64') is lenient about
 * invalid characters (silently drops them rather than throwing), so an empty
 * result from non-empty input is the one cheap, reliable signal that this
 * wasn't real base64 -- not a full RFC 4648 validator, but enough to turn a
 * malformed payload into a clear INVALID_PROTOCOL instead of a cryptic
 * downstream failure. */
export function decodeCiphertext(value: string): Buffer {
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0) {
    throw new BadRequestException({
      code: MESSAGING_ERRORS.INVALID_PROTOCOL,
      message: 'ciphertext must be valid base64',
    });
  }
  return buffer;
}
