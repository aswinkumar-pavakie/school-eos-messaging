// Injectable pg Pool wrapper — raw parameterized SQL, no ORM, mirroring
// school-eos-backend's own src/infrastructure/postgres/postgres.service.ts
// exactly, for consistency across the two services one team maintains.
//
// Connects to the SAME real Supabase PostgreSQL project Core uses (see
// .env.example's DATABASE_URL comment) — every query issued by this service
// schema-qualifies its tables as `messaging.<table>` explicitly (never relying
// on search_path), so this pool can never accidentally read/write a Core
// `public` schema table just because a query forgot to qualify a name.

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';

/** Anything that can run a parameterized query — a Pool, or a PoolClient mid-transaction. */
export interface Queryable {
  query<R extends QueryResultRow = any>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
}

@Injectable()
export class PostgresService implements OnModuleDestroy, Queryable {
  readonly pool: Pool;

  constructor(configService: ConfigService) {
    this.pool = new Pool({
      connectionString: configService.get<string>('database.url'),
      // Bounded, not pg's own default of 0 (= wait forever) -- confirmed live:
      // an unreachable database otherwise hangs /health/ready (and any real
      // query) indefinitely instead of failing fast, which is exactly the
      // "never let a dependency check hang the request" failure mode LLD §40/
      // §57 warns about.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 10,
    });

    // pg's own documented gotcha: an IDLE pooled client can have its connection
    // reset by the server (e.g. Supabase's pooler recycling it) at any time,
    // unrelated to any in-flight query. Node treats an 'error' event with no
    // listener as fatal and crashes the whole process — logging and swallowing
    // it here is the standard, correct fix: the dead client is removed from the
    // pool and a fresh one opened on the next query.
    this.pool.on('error', (err) => {
      console.error(
        '[PostgresService] Idle pool client error (connection recycled, pool continues):',
        err.message,
      );
    });
  }

  query<R extends QueryResultRow = any>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, params as any[]);
  }

  connect(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /** Read-only health check — used by /health/ready, never anything else. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
