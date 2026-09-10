import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CoreIntegrationModule } from '../core-integration/core-integration.module';
import { PresenceModule } from '../presence/presence.module';
import { OutboxEventsRepository } from './repositories/outbox-events.repository';
import { OutboxWorkerService } from './outbox-worker.service';

@Module({
  imports: [ScheduleModule.forRoot(), CoreIntegrationModule, PresenceModule],
  providers: [OutboxEventsRepository, OutboxWorkerService],
  exports: [OutboxEventsRepository],
})
export class OutboxModule {}
