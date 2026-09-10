import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { DevicesModule } from '../devices/devices.module';
import { E2eeKeysRepository } from './repositories/e2ee-keys.repository';
import { E2eeController } from './e2ee.controller';
import { E2eeService } from './e2ee.service';

@Module({
  imports: [AuthorizationModule, DevicesModule],
  controllers: [E2eeController],
  providers: [E2eeKeysRepository, E2eeService],
})
export class E2eeModule {}
