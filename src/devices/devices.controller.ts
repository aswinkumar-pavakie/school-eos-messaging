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
import { RegisterDeviceDto } from './dto/register-device.dto';
import { DevicesService } from './devices.service';

const DEVICE_REGISTER_LIMIT_PER_HOUR = 10; // LLD §34/§38/§60: device registration spikes are an explicitly monitored abuse signal.

@Controller('devices')
export class DevicesController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  async listMine(@CurrentActor() actor: AuthenticatedUser) {
    return { data: await this.devicesService.listMine(actor.personId) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDeviceDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const allowed = await this.rateLimit.consume(
      'device-register',
      actor.personId,
      DEVICE_REGISTER_LIMIT_PER_HOUR,
      3600,
    );
    if (!allowed)
      throw new ForbiddenException({ code: MESSAGING_ERRORS.RATE_LIMITED });

    const device = await this.devicesService.register(
      actor.personId,
      dto.devicePublicKey,
      dto.platform,
      dto.appVersion,
    );
    return { data: device };
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    await this.devicesService.revoke(id, actor.personId);
    return { data: { revoked: true } };
  }
}
