import { Module } from '@nestjs/common';
import { MessagingDevicesRepository } from './repositories/messaging-devices.repository';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  controllers: [DevicesController],
  providers: [MessagingDevicesRepository, DevicesService],
  exports: [MessagingDevicesRepository, DevicesService],
})
export class DevicesModule {}
