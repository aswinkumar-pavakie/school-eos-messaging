import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentActor } from '../auth/current-actor.decorator';
import { MESSAGING_ERRORS } from '../common/errors/error-codes';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { DirectoryService } from './directory.service';
import { DiscoveryQueryDto } from './dto/discovery.query.dto';

const DIRECTORY_SEARCH_LIMIT_PER_MINUTE = 30; // LLD §34/§38 -- directory search is an explicitly named rate-limited dimension (anti-scraping).

@Controller('discovery')
export class DirectoryController {
  constructor(
    private readonly directoryService: DirectoryService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  async discover(
    @Query() query: DiscoveryQueryDto,
    @CurrentActor() actor: AuthenticatedUser,
  ) {
    const allowed = await this.rateLimit.consume(
      'directory-search',
      actor.personId,
      DIRECTORY_SEARCH_LIMIT_PER_MINUTE,
      60,
    );
    if (!allowed)
      throw new ForbiddenException({ code: MESSAGING_ERRORS.RATE_LIMITED });

    const result = await this.directoryService.discover(
      { personId: actor.personId, roles: actor.roles },
      { search: query.search, cursor: query.cursor, limit: query.limit },
    );
    return { items: result.items, nextCursor: result.nextCursor };
  }
}
