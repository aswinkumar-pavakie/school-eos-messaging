import { Module } from '@nestjs/common';
import { CoreIntegrationModule } from '../core-integration/core-integration.module';
import { RelationshipsService } from './relationships.service';

@Module({
  imports: [CoreIntegrationModule],
  providers: [RelationshipsService],
  exports: [RelationshipsService],
})
export class RelationshipsModule {}
