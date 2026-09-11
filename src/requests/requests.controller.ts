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
import { IsIn, IsOptional } from 'class-validator';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentActor } from '../auth/current-actor.decorator';
import { MESSAGING_ERRORS } from '../common/errors/error-codes';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { decodeCiphertext } from '../conversations/conversations.controller';
import { CreateRequestDto } from './dto/create-request.dto';
import { RequestStatus } from './repositories/conversation-requests.repository';
import { RequestsService } from './requests.service';

const REQUEST_CREATE_LIMIT_PER_HOUR = 10; // LLD §38: one of the specifically-named rate-limited dimensions.

class ListRequestsQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'])
  status?: RequestStatus;

  @IsOptional()
  @IsIn(['recipient', 'requester'])
  as?: 'recipient' | 'requester';
}

@Controller('requests')
export class RequestsController {
  constructor(
    private readonly requestsService: RequestsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  async list(
    @Query() query: ListRequestsQueryDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const status = query.status ?? 'PENDING';
    const items =
      query.as === 'requester'
        ? await this.requestsService.listForRequester(actor.personId, status)
        : await this.requestsService.listForRecipient(actor.personId, status);
    return { data: items };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateRequestDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const allowed = await this.rateLimit.consume(
      'request-create',
      actor.personId,
      REQUEST_CREATE_LIMIT_PER_HOUR,
      3600,
    );
    if (!allowed)
      throw new ForbiddenException({ code: MESSAGING_ERRORS.RATE_LIMITED });

    const result = await this.requestsService.createRequest({
      actorPersonId: actor.personId,
      actorRoles: actor.roles,
      targetPersonId: dto.targetPersonId,
      mlsWelcome: dto.mlsWelcome ? decodeCiphertext(dto.mlsWelcome) : undefined,
      initialMessage: {
        clientMessageId: dto.initialMessage.clientMessageId,
        ciphertext: decodeCiphertext(dto.initialMessage.ciphertext),
        encryptionVersion: dto.initialMessage.encryptionVersion,
        encryptionHeader: dto.initialMessage.encryptionHeader ?? {},
      },
    });
    return { data: result };
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    return { data: await this.requestsService.accept(id, actor.personId) };
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  async decline(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    return { data: await this.requestsService.decline(id, actor.personId) };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    return { data: await this.requestsService.cancel(id, actor.personId) };
  }
}
