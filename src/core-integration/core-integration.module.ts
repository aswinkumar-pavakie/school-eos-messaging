import { Module } from '@nestjs/common';
import { CoreIntegrationService } from './core-integration.service';

@Module({
  providers: [CoreIntegrationService],
  exports: [CoreIntegrationService],
})
export class CoreIntegrationModule {}
