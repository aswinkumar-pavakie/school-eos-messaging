// Runs a callback inside a single BEGIN/COMMIT/ROLLBACK against one pooled
// connection. Raw-pg equivalent of a $transaction helper — copied verbatim from
// school-eos-backend's own src/common/transactions/unit-of-work.ts. Used
// wherever a request must atomically touch more than one table (message send +
// conversation update + outbox event, request creation + conversation +
// member rows, etc. — see LLD §29-33/§56).

import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PostgresService } from '../postgres/postgres.service';

@Injectable()
export class UnitOfWork {
  constructor(private readonly postgres: PostgresService) {}

  async run<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.postgres.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
