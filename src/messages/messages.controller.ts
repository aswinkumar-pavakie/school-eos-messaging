import {
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
import { IsInt, Min } from 'class-validator';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentActor } from '../auth/current-actor.decorator';
import { MESSAGING_ERRORS } from '../common/errors/error-codes';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { decodeCiphertext } from '../conversations/conversations.controller';
import { ConversationMembersRepository } from '../conversations/repositories/conversation-members.repository';
import { MessageReadStateRepository } from '../read-state/repositories/message-read-state.repository';
import {
  DEFAULT_MESSAGES_LIMIT,
  ListMessagesQueryDto,
  SyncMessagesQueryDto,
} from './dto/list-messages.query.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { MessagesService } from './messages.service';

const MESSAGE_SEND_LIMIT_PER_MINUTE = 60; // LLD §34/§38.

class MarkReadDto {
  // Confirmed live: with no validation decorator here, the global
  // ValidationPipe's whitelist (forbidNonWhitelisted: true) treated
  // `sequence` as an unrecognized property and rejected every real request
  // with 400 "property sequence should not exist" -- this class needs the
  // same real decorators every other DTO in this service has, not just a
  // plain TypeScript type annotation (which class-validator never sees).
  @IsInt()
  @Min(0)
  sequence!: number;
}

@Controller('conversations/:conversationId')
export class MessagesController {
  constructor(
    private readonly messagesService: MessagesService,
    private readonly readStateRepo: MessageReadStateRepository,
    private readonly membersRepo: ConversationMembersRepository,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get('messages')
  async history(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: ListMessagesQueryDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const limit = query.limit ?? DEFAULT_MESSAGES_LIMIT;
    const items = await this.messagesService.history(
      conversationId,
      actor.personId,
      query.before ?? null,
      limit,
    );
    return {
      data: items.map(toMessageResponse),
      meta: {
        hasMore: items.length === limit,
        nextCursor: items.length ? items[0].sequenceNo : null,
      },
    };
  }

  @Get('sync')
  async sync(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: SyncMessagesQueryDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const limit = query.limit ?? 200;
    const items = await this.messagesService.sync(
      conversationId,
      actor.personId,
      query.afterSequence,
      limit,
    );
    return { data: items.map(toMessageResponse) };
  }

  @Post('messages')
  @HttpCode(HttpStatus.OK)
  async send(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: SendMessageDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const allowed = await this.rateLimit.consume(
      'message-send',
      actor.personId,
      MESSAGE_SEND_LIMIT_PER_MINUTE,
      60,
    );
    if (!allowed)
      throw new ForbiddenException({ code: MESSAGING_ERRORS.RATE_LIMITED });

    const result = await this.messagesService.send({
      conversationId,
      senderPersonId: actor.personId,
      clientMessageId: dto.clientMessageId,
      ciphertext: decodeCiphertext(dto.ciphertext),
      encryptionVersion: dto.encryptionVersion,
      encryptionHeader: dto.encryptionHeader ?? {},
    });
    return { data: result };
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: MarkReadDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    // Membership re-verified here too -- a read-state write is still a
    // conversation-scoped mutation, not exempt from access control (LLD §28
    // cross-user read-state manipulation is an explicit §63 security test).
    const membership = await this.membersRepo.findMembership(
      conversationId,
      actor.personId,
    );
    if (!membership || membership.membershipStatus !== 'ACTIVE') {
      throw new ForbiddenException({ code: MESSAGING_ERRORS.ACCESS_DENIED });
    }
    await this.readStateRepo.upsert(
      conversationId,
      actor.personId,
      body.sequence,
    );
    return { data: { conversationId, lastReadSequence: body.sequence } };
  }
}

function toMessageResponse(message: {
  id: string;
  conversationId: string;
  senderPersonId: string;
  sequenceNo: number;
  ciphertext: Buffer;
  encryptionVersion: string;
  encryptionHeader: Record<string, unknown>;
  createdAt: string;
}) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderPersonId: message.senderPersonId,
    sequence: message.sequenceNo,
    ciphertext: message.ciphertext.toString('base64'),
    encryptionVersion: message.encryptionVersion,
    encryptionHeader: message.encryptionHeader,
    createdAt: message.createdAt,
  };
}
