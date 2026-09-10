import { Injectable } from '@nestjs/common';
import {
  PostgresService,
  Queryable,
} from '../../common/postgres/postgres.service';

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED';

@Injectable()
export class MessageDeliveryRepository {
  constructor(private readonly postgres: PostgresService) {}

  async create(
    messageId: string,
    recipientPersonId: string,
    executor: Queryable,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO messaging.message_delivery (message_id, recipient_person_id)
       VALUES ($1, $2)`,
      [messageId, recipientPersonId],
    );
  }

  async markDelivered(
    messageId: string,
    recipientPersonId: string,
    deviceId: string | null,
    executor: Queryable = this.postgres,
  ): Promise<void> {
    await executor.query(
      `UPDATE messaging.message_delivery
       SET delivery_status = 'DELIVERED', delivered_at = now(), device_id = COALESCE($3, device_id)
       WHERE message_id = $1 AND recipient_person_id = $2`,
      [messageId, recipientPersonId, deviceId],
    );
  }

  async markFailed(
    messageId: string,
    recipientPersonId: string,
    executor: Queryable = this.postgres,
  ): Promise<void> {
    await executor.query(
      `UPDATE messaging.message_delivery SET delivery_status = 'FAILED' WHERE message_id = $1 AND recipient_person_id = $2`,
      [messageId, recipientPersonId],
    );
  }
}
