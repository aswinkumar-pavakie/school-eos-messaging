import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { RateLimitModule } from '../ratelimit/rate-limit.module';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  imports: [OutboxModule, RateLimitModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
