import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DevicesModule } from '../devices/devices.module';
import { MessagesModule } from '../messages/messages.module';
import { PresenceModule } from '../presence/presence.module';
import { RateLimitModule } from '../ratelimit/rate-limit.module';
import { RequestsModule } from '../requests/requests.module';
import { ConnectionRegistryService } from './connection-registry.service';
import { MessagingGateway } from './messaging.gateway';
import { RedisSubscriberService } from './redis-subscriber.service';

@Module({
  imports: [
    AuthModule,
    DevicesModule,
    PresenceModule,
    MessagesModule,
    RequestsModule,
    RateLimitModule,
  ],
  providers: [
    MessagingGateway,
    ConnectionRegistryService,
    RedisSubscriberService,
  ],
})
export class WebsocketModule {}
