// WSS /messaging/socket -- LLD §35-39. Every single event, without
// exception, re-runs authentication + validation + authorization before
// acting (LLD §38's explicit rule: "a connection alone never authorizes a
// message"). message.send calls the EXACT SAME MessagesService.send() the
// REST controller calls -- one pipeline, never a second copy (LLD §56).

import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuditService } from '../audit/audit.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { ConversationMembersRepository } from '../conversations/repositories/conversation-members.repository';
import { MessageReadStateRepository } from '../read-state/repositories/message-read-state.repository';
import { MessagesService } from '../messages/messages.service';
import { RequestsService } from '../requests/requests.service';
import { PresenceService } from '../presence/presence.service';
import { RedisService } from '../common/redis/redis.service';
import { MessagingDevicesRepository } from '../devices/repositories/messaging-devices.repository';
import { ConnectionRegistryService } from './connection-registry.service';
import {
  ConversationReadPayload,
  MessageSendPayload,
  RequestDecisionPayload,
  SyncRequestPayload,
  TypingPayload,
} from './dto/ws-payloads.dto';
import { validateWsPayload } from './ws-validate.util';

const MESSAGE_SEND_LIMIT_PER_MINUTE = 60;
const TYPING_TTL_SECONDS = 8;

interface SocketData {
  personId: string;
  roles: string[];
  deviceId: string | null;
}

function socketData(client: Socket): SocketData {
  return client.data as SocketData;
}

@WebSocketGateway({
  path: '/messaging/socket',
  cors: { origin: '*' },
})
export class MessagingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MessagingGateway.name);

  constructor(
    private readonly jwtAuthGuard: JwtAuthGuard,
    private readonly devicesRepo: MessagingDevicesRepository,
    private readonly registry: ConnectionRegistryService,
    private readonly presence: PresenceService,
    private readonly redis: RedisService,
    private readonly messagesService: MessagesService,
    private readonly requestsService: RequestsService,
    private readonly membersRepo: ConversationMembersRepository,
    private readonly readStateRepo: MessageReadStateRepository,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  // ---- Connection lifecycle (LLD §39) --------------------------------------

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) throw new Error('missing token');
      const user = await this.jwtAuthGuard.verifyToken(token);

      const deviceId = this.extractDeviceId(client);
      let validatedDeviceId: string | null = null;
      if (deviceId) {
        const device = await this.devicesRepo.findById(deviceId);
        if (
          !device ||
          device.personId !== user.personId ||
          device.status !== 'ACTIVE'
        ) {
          // A stale/revoked/foreign device id must never silently succeed
          // without a device — reject the whole connection (LLD §49: a
          // revoked device is disconnected, never allowed to remain
          // ambiguously "maybe still valid").
          this.audit.record('WEBSOCKET_AUTH_FAILURE', {
            actorPersonId: user.personId,
            metadata: { reason: 'invalid_device' },
          });
          client.emit('error', { code: 'DEVICE_REVOKED' });
          client.disconnect(true);
          return;
        }
        validatedDeviceId = device.id;
        await this.devicesRepo.touchLastSeen(device.id);
      }

      client.data = {
        personId: user.personId,
        roles: user.roles,
        deviceId: validatedDeviceId,
      } satisfies SocketData;
      this.registry.add(user.personId, client);
      await this.presence.markOnline(user.personId);

      // A fresh connection should always re-sync -- covers both "was
      // genuinely offline" and "just reconnected after a brief drop" without
      // needing real gap-detection logic here (LLD §45 frames gap detection
      // as primarily client-driven; this is the safe, simple nudge that
      // makes that client-side logic actually fire on every reconnect).
      client.emit('sync.required', {});
    } catch (err) {
      this.logger.warn(
        `WebSocket connection rejected: ${err instanceof Error ? err.message : err}`,
      );
      await this.audit.record('WEBSOCKET_AUTH_FAILURE', {
        metadata: { reason: 'invalid_token' },
      });
      client.emit('error', { code: 'AUTHENTICATION_REQUIRED' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const data = client.data as SocketData | undefined;
    if (!data?.personId) return;
    this.registry.remove(data.personId, client);
    // Deliberately no explicit presence.markOffline() here -- see
    // PresenceService's own header comment: a shared, Redis-TTL'd key is
    // correct for multi-instance deployments (another instance's live
    // connection for the same person keeps refreshing the same key), a
    // local per-socket disconnect on ONE instance is not sufficient
    // evidence the person is offline everywhere.
  }

  // ---- message.send (LLD §33/§36) ------------------------------------------

  @SubscribeMessage('message.send')
  async onMessageSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    const data = socketData(client);
    const parsed = validateWsPayload(MessageSendPayload, body);
    if (!parsed.valid)
      return this.emitError(client, 'INVALID_PROTOCOL', parsed.errors);

    const allowed = await this.rateLimit.consume(
      'message-send',
      data.personId,
      MESSAGE_SEND_LIMIT_PER_MINUTE,
      60,
    );
    if (!allowed) return this.emitError(client, 'RATE_LIMITED');

    try {
      const ciphertext = Buffer.from(parsed.value.ciphertext, 'base64');
      if (ciphertext.length === 0)
        return this.emitError(client, 'INVALID_PROTOCOL', [
          'ciphertext must be valid base64',
        ]);

      const result = await this.messagesService.send({
        conversationId: parsed.value.conversationId,
        senderPersonId: data.personId,
        clientMessageId: parsed.value.clientMessageId,
        ciphertext,
        encryptionVersion: parsed.value.encryptionVersion,
        encryptionHeader: parsed.value.encryptionHeader ?? {},
      });
      client.emit('message.accepted', result);
    } catch (err) {
      this.emitError(client, this.errorCodeOf(err));
    }
  }

  // ---- conversation.read (LLD §36) -----------------------------------------

  @SubscribeMessage('conversation.read')
  async onConversationRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    const data = socketData(client);
    const parsed = validateWsPayload(ConversationReadPayload, body);
    if (!parsed.valid)
      return this.emitError(client, 'INVALID_PROTOCOL', parsed.errors);

    const membership = await this.membersRepo.findMembership(
      parsed.value.conversationId,
      data.personId,
    );
    if (!membership || membership.membershipStatus !== 'ACTIVE') {
      return this.emitError(client, 'ACCESS_DENIED');
    }
    await this.readStateRepo.upsert(
      parsed.value.conversationId,
      data.personId,
      parsed.value.sequence,
    );

    // Tell the OTHER member their message was read (LLD §31/§37: message.read).
    const other = await this.membersRepo.findOtherMember(
      parsed.value.conversationId,
      data.personId,
    );
    if (other) {
      await this.redis.client.publish(
        `ws:user:${other.personId}`,
        JSON.stringify({
          type: 'message.read',
          conversationId: parsed.value.conversationId,
          sequence: parsed.value.sequence,
          readerPersonId: data.personId,
        }),
      );
    }
    client.emit('conversation.updated', {
      conversationId: parsed.value.conversationId,
      ownLastReadSequence: parsed.value.sequence,
    });
  }

  // ---- typing (LLD §27/§36/§37) -- ephemeral, Redis only, never persisted --

  @SubscribeMessage('typing.start')
  async onTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    await this.handleTyping(client, body, 'typing.started');
  }

  @SubscribeMessage('typing.stop')
  async onTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    await this.handleTyping(client, body, 'typing.stopped');
  }

  private async handleTyping(
    client: Socket,
    body: unknown,
    eventType: 'typing.started' | 'typing.stopped',
  ) {
    const data = socketData(client);
    const parsed = validateWsPayload(TypingPayload, body);
    if (!parsed.valid)
      return this.emitError(client, 'INVALID_PROTOCOL', parsed.errors);

    const membership = await this.membersRepo.findMembership(
      parsed.value.conversationId,
      data.personId,
    );
    if (!membership || membership.membershipStatus !== 'ACTIVE') return; // silently ignore, no need to leak state to a non-member

    const key = `typing:${parsed.value.conversationId}:${data.personId}`;
    if (eventType === 'typing.started') {
      await this.redis.client.set(key, '1', 'EX', TYPING_TTL_SECONDS);
    } else {
      await this.redis.client.del(key);
    }

    const other = await this.membersRepo.findOtherMember(
      parsed.value.conversationId,
      data.personId,
    );
    if (other) {
      await this.redis.client.publish(
        `ws:user:${other.personId}`,
        JSON.stringify({
          type: eventType,
          conversationId: parsed.value.conversationId,
          personId: data.personId,
        }),
      );
    }
  }

  // ---- request.accept / request.decline (LLD §36) --------------------------

  @SubscribeMessage('request.accept')
  async onRequestAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    const data = socketData(client);
    const parsed = validateWsPayload(RequestDecisionPayload, body);
    if (!parsed.valid)
      return this.emitError(client, 'INVALID_PROTOCOL', parsed.errors);
    try {
      const result = await this.requestsService.accept(
        parsed.value.requestId,
        data.personId,
      );
      client.emit('request.accepted', result);
    } catch (err) {
      this.emitError(client, this.errorCodeOf(err));
    }
  }

  @SubscribeMessage('request.decline')
  async onRequestDecline(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    const data = socketData(client);
    const parsed = validateWsPayload(RequestDecisionPayload, body);
    if (!parsed.valid)
      return this.emitError(client, 'INVALID_PROTOCOL', parsed.errors);
    try {
      const result = await this.requestsService.decline(
        parsed.value.requestId,
        data.personId,
      );
      client.emit('request.declined', result);
    } catch (err) {
      this.emitError(client, this.errorCodeOf(err));
    }
  }

  // ---- sync.request (LLD §36/§44) ------------------------------------------

  @SubscribeMessage('sync.request')
  async onSyncRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    const data = socketData(client);
    const parsed = validateWsPayload(SyncRequestPayload, body);
    if (!parsed.valid)
      return this.emitError(client, 'INVALID_PROTOCOL', parsed.errors);
    try {
      const messages = await this.messagesService.sync(
        parsed.value.conversationId,
        data.personId,
        parsed.value.afterSequence,
        200,
      );
      client.emit('sync.response', {
        conversationId: parsed.value.conversationId,
        messages: messages.map((m) => ({
          id: m.id,
          sequence: m.sequenceNo,
          senderPersonId: m.senderPersonId,
          ciphertext: m.ciphertext.toString('base64'),
          encryptionVersion: m.encryptionVersion,
          encryptionHeader: m.encryptionHeader,
          createdAt: m.createdAt,
        })),
      });
    } catch (err) {
      this.emitError(client, this.errorCodeOf(err));
    }
  }

  // ---- ping/heartbeat (LLD §39) ---------------------------------------------

  @SubscribeMessage('ping')
  async onPing(@ConnectedSocket() client: Socket) {
    const data = socketData(client);
    await this.presence.refresh(data.personId);
    client.emit('pong', { at: new Date().toISOString() });
  }

  // ---- Cross-instance fan-out delivery (called by RedisSubscriberService) --

  /** Forwards an already-authorized event to every locally-connected socket
   * for this person -- called only from RedisSubscriberService, never
   * directly by a client-facing handler. The event was already fully
   * authorized at write time (it only exists because OutboxWorkerService
   * published it after a real, already-checked business operation
   * committed) -- this is pure delivery, not a second authorization point. */
  deliverToLocalSockets(
    personId: string,
    event: Record<string, unknown>,
  ): void {
    const sockets = this.registry.getSockets(personId);
    if (sockets.length === 0) return;
    const eventName =
      typeof event.type === 'string' ? event.type : 'message.new';
    for (const socket of sockets) {
      socket.emit(eventName, event);
    }
  }

  private extractToken(client: Socket): string | undefined {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') return auth.token;
    const queryToken = client.handshake.query?.token;
    return typeof queryToken === 'string' ? queryToken : undefined;
  }

  private extractDeviceId(client: Socket): string | undefined {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.deviceId === 'string') return auth.deviceId;
    const queryDeviceId = client.handshake.query?.deviceId;
    return typeof queryDeviceId === 'string' ? queryDeviceId : undefined;
  }

  private emitError(client: Socket, code: string, details?: string[]): void {
    client.emit('error', { code, details });
  }

  /** Recognized domain errors (thrown as a NestJS HttpException with a
   * { code } body, exactly like every REST controller's own error shape)
   * surface their real LLD §52 code. Anything else -- a genuinely unexpected
   * failure (DB unreachable, a bug) -- gets a generic, honest code instead
   * of being mis-reported as an authorization decision that was never
   * actually made; the real error is logged server-side, never sent to the
   * client (same posture as HttpExceptionFilter's own REST-side handling of
   * an unhandled exception). */
  private errorCodeOf(err: unknown): string {
    if (typeof err === 'object' && err !== null && 'response' in err) {
      const response = (err as { response?: unknown }).response;
      if (
        typeof response === 'object' &&
        response !== null &&
        'code' in response
      ) {
        return String((response as { code: unknown }).code);
      }
    }
    this.logger.error(
      `Unrecognized WebSocket handler error: ${err instanceof Error ? err.message : err}`,
    );
    return 'INTERNAL_ERROR';
  }
}
