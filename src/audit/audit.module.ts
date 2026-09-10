import { Global, Module } from '@nestjs/common';
import { SecurityEventsRepository } from './repositories/security-events.repository';
import { AuditService } from './audit.service';

@Global()
@Module({
  providers: [SecurityEventsRepository, AuditService],
  exports: [AuditService],
})
export class AuditModule {}
