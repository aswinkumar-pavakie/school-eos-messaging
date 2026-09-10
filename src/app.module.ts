import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { validate } from './config/validation.schema';
import { PostgresModule } from './common/postgres/postgres.module';
import { RedisModule } from './common/redis/redis.module';
import { DomainRepositoriesModule } from './common/domain-repositories.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { RateLimitModule } from './ratelimit/rate-limit.module';
import { HealthModule } from './health/health.module';
import { CoreIntegrationModule } from './core-integration/core-integration.module';
import { RelationshipsModule } from './relationships/relationships.module';
import { AuthorizationModule } from './authorization/authorization.module';
import { DirectoryModule } from './directory/directory.module';
import { ConversationsModule } from './conversations/conversations.module';
import { RequestsModule } from './requests/requests.module';
import { MessagesModule } from './messages/messages.module';
import { OutboxModule } from './outbox/outbox.module';
import { PresenceModule } from './presence/presence.module';
import { DevicesModule } from './devices/devices.module';
import { E2eeModule } from './e2ee/e2ee.module';
import { WebsocketModule } from './websocket/websocket.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate,
    }),
    PostgresModule,
    RedisModule,
    DomainRepositoriesModule,
    AuditModule,
    RateLimitModule,
    AuthModule,
    HealthModule,
    CoreIntegrationModule,
    RelationshipsModule,
    AuthorizationModule,
    DirectoryModule,
    ConversationsModule,
    RequestsModule,
    MessagesModule,
    OutboxModule,
    PresenceModule,
    DevicesModule,
    E2eeModule,
    WebsocketModule,
  ],
})
export class AppModule {}
