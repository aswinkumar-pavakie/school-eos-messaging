// The core messaging-domain repositories (conversations, members, requests,
// messages, delivery, read-state) are used pervasively across
// conversations/requests/messages/directory/outbox — global, like
// PostgresModule/AuditModule/RateLimitModule, purely to avoid every feature
// module re-declaring the same six stateless, PostgresService-only
// providers and tangling into circular module imports (conversations needs
// the requests repository and vice versa). Each one is still a plain
// injectable class, still fully mockable in unit tests -- this only changes
// how the module graph wires them, not how they behave.

import { Global, Module } from '@nestjs/common';
import { ConversationMembersRepository } from '../conversations/repositories/conversation-members.repository';
import { ConversationsRepository } from '../conversations/repositories/conversations.repository';
import { MessageDeliveryRepository } from '../delivery/repositories/message-delivery.repository';
import { MessagesRepository } from '../messages/repositories/messages.repository';
import { MessageReadStateRepository } from '../read-state/repositories/message-read-state.repository';
import { ConversationRequestsRepository } from '../requests/repositories/conversation-requests.repository';

@Global()
@Module({
  providers: [
    ConversationsRepository,
    ConversationMembersRepository,
    ConversationRequestsRepository,
    MessagesRepository,
    MessageDeliveryRepository,
    MessageReadStateRepository,
  ],
  exports: [
    ConversationsRepository,
    ConversationMembersRepository,
    ConversationRequestsRepository,
    MessagesRepository,
    MessageDeliveryRepository,
    MessageReadStateRepository,
  ],
})
export class DomainRepositoriesModule {}
