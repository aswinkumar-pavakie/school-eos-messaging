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
      // Raised from 10 -- confirmed live as the real cause of a system-wide
      // slowdown (basic listConversations/listRequests calls taking 16-34
      // SECONDS, discoverUsersAction eventually 500ing with no error code):
      // this service's own advisory-lock transaction in devices.service.ts's
      // register() holds one connection for its full duration, and with
      // useE2eeBootstrap now wired into every role's shell (so it fires on
      // every dashboard load, not just Messages), real concurrent traffic
      // across many roles was queuing on a 10-connection pool shared by
      // every endpoint this service has -- one slow/contended path
      // (registration) was starving all the others. Same fix, same
      // reasoning, as school-eos-backend's own postgres.service.ts pool
      // raise earlier this session -- not a guess, the identical anti-
      // pattern in the sibling service.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      max: 25,
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

  /** Runs `fn` inside a single BEGIN/COMMIT transaction on one dedicated
   * client, rolling back on any thrown error. Needed wherever a
   * read-then-write sequence (e.g. "revoke every prior row, then insert a
   * new one") must be atomic across concurrent callers -- pool.query() alone
   * runs each statement on a fresh/arbitrary connection with no isolation
   * between them, so two overlapping calls can each read the same
   * pre-write state and both proceed, which is exactly how
   * devices.service.ts's register() ended up leaving more than one row
   * ACTIVE for the same person (confirmed live via a direct DB check: six
   * real people had 2-8 simultaneously ACTIVE devices, which the single-
   * active-device V1 design treats as impossible). */
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Read-only health check — used by /health/ready, never anything else. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
