import { Module } from '@nestjs/common';
import { CoreIntegrationModule } from '../core-integration/core-integration.module';
import { RelationshipsModule } from '../relationships/relationships.module';
import { AuthorizationService } from './authorization.service';

@Module({
  imports: [CoreIntegrationModule, RelationshipsModule],
  providers: [AuthorizationService],
  exports: [AuthorizationService],
})
export class AuthorizationModule {}
