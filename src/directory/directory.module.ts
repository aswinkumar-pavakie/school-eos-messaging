import { Module } from '@nestjs/common';
import { CoreIntegrationModule } from '../core-integration/core-integration.module';
import { RateLimitModule } from '../ratelimit/rate-limit.module';
import { RelationshipsModule } from '../relationships/relationships.module';
import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';

@Module({
  imports: [CoreIntegrationModule, RelationshipsModule, RateLimitModule],
  controllers: [DirectoryController],
  providers: [DirectoryService],
})
export class DirectoryModule {}
