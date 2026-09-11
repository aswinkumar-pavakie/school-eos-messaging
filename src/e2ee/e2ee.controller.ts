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
} from '@nestjs/common';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentActor } from '../auth/current-actor.decorator';
import { MESSAGING_ERRORS } from '../common/errors/error-codes';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import {
  PublishMlsKeyPackagesDto,
  PublishPrekeysDto,
} from './dto/publish-prekeys.dto';
import { E2eeService } from './e2ee.service';

const PREKEY_PUBLISH_LIMIT_PER_HOUR = 20; // LLD §34/§38: "E2EE key operations" is an explicitly named rate-limited dimension.

@Controller('keys')
export class E2eeController {
  constructor(
    private readonly e2eeService: E2eeService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post('prekeys')
  @HttpCode(HttpStatus.OK)
  async publish(
    @Body() dto: PublishPrekeysDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const allowed = await this.rateLimit.consume(
      'e2ee-publish',
      actor.personId,
      PREKEY_PUBLISH_LIMIT_PER_HOUR,
      3600,
    );
    if (!allowed)
      throw new ForbiddenException({ code: MESSAGING_ERRORS.RATE_LIMITED });

    await this.e2eeService.publish(actor.personId, dto);
    return { data: { published: true } };
  }

  /** Mirrors POST /keys/prekeys, but for MLS KeyPackages -- the client needs
   * the created row ids back (unlike a plain prekey publish) to durably map
   * server KeyPackage id <-> local private KeyPackage material. */
  @Post('mls-key-packages')
  @HttpCode(HttpStatus.OK)
  async publishMlsKeyPackages(
    @Body() dto: PublishMlsKeyPackagesDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const allowed = await this.rateLimit.consume(
      'e2ee-publish',
      actor.personId,
      PREKEY_PUBLISH_LIMIT_PER_HOUR,
      3600,
    );
    if (!allowed)
      throw new ForbiddenException({ code: MESSAGING_ERRORS.RATE_LIMITED });

    const ids = await this.e2eeService.publishMlsKeyPackages(
      actor.personId,
      dto.deviceId,
      dto.keyPackages,
    );
    return { data: { ids } };
  }

  @Get(':userId')
  async getKeyBundle(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const bundles = await this.e2eeService.getKeyBundleForUser(
      { personId: actor.personId, roles: actor.roles },
      userId,
    );
    return { data: bundles };
  }
}
