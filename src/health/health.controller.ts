// Liveness/readiness per LLD §51. Deliberately hand-rolled rather than pulling
// in @nestjs/terminus for two checks — avoids a dependency for a genuinely
// simple need (the user's own "avoid unnecessary infrastructure complexity").
// Never exposes internal infrastructure details (connection strings, stack
// traces) in the response body.

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PostgresService } from '../common/postgres/postgres.service';
import { RedisService } from '../common/redis/redis.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly postgres: PostgresService,
    private readonly redis: RedisService,
  ) {}

  /** Process is up and able to serve requests at all — no dependency checks.
   * A load balancer restarts the instance if this ever fails to respond. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Every dependency this instance actually needs to do real work is
   * reachable right now — a load balancer stops routing new traffic here (but
   * does not restart the instance) if this fails. */
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async ready(): Promise<{ status: 'ok'; database: 'ok'; redis: 'ok' }> {
    const [dbResult, redisResult] = await Promise.allSettled([
      this.postgres.ping(),
      this.redis.ping(),
    ]);

    if (dbResult.status === 'rejected' || redisResult.status === 'rejected') {
      throw new ServiceUnavailableException({
        message: 'Not ready',
        database: dbResult.status === 'fulfilled' ? 'ok' : 'unavailable',
        redis: redisResult.status === 'fulfilled' ? 'ok' : 'unavailable',
      });
    }

    return { status: 'ok', database: 'ok', redis: 'ok' };
  }
}
