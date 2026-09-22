// The ONE approved way this service reads relationship/user data from Core
// (LLD §79 — never a direct query against Core's database). Every method
// throws CoreIntegrationUnavailableError on ANY failure (network, timeout,
// non-2xx, malformed body) — it never returns an empty/default result to
// paper over a failure, because an empty array and "couldn't check" must
// never be indistinguishable to the authorization layer that fails closed
// on this error (LLD §71/§32 of the approved plan's "explicit assumptions").
//
// A short in-process cache (a few seconds) absorbs duplicate calls within
// one logical request (e.g. discovery resolving the same actor's
// relationships multiple times) — deliberately NOT Redis-backed or shared
// across instances: LLD §67-70 frames a real shared relationship projection
// as a later scaling optimization, not a requirement at 1,000-1,500 DAU, and
// a few seconds of staleness for a same-process cache is bounded and
// harmless (a real access decision still re-runs relationship resolution on
// the very next request from any other process/instance).

import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CoreIntegrationUnavailableError,
  CoreUserProjection,
  ListMessagingUsersResult,
} from './core-integration.types';

// 45s, not 5s -- Core (school-eos-backend) runs on Render's free tier, which
// sleeps when idle and can take 30-60s to wake on the first request after a
// while (same documented fact as the website/mobile .env comments for this
// service's own cold start). A 5s abort meant EVERY call made during Core's
// wake-up window failed with "This operation was aborted", surfacing as a
// generic 500 on discovery/authorization/outbox delivery -- confirmed live
// via Render logs (a burst of aborted GET /users/:id calls, not 401s/404s).
const REQUEST_TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 5_000;

// A DIFFERENT cold-start failure mode from the one the 45s timeout above
// covers -- confirmed live via fresh Render logs: while Core's container is
// still spinning up, Render's own edge proxy in front of it rejects
// incoming requests with a flat 429 before the request ever reaches the
// NestJS app (no application-level rate limiter exists anywhere in Core's
// own codebase -- confirmed by grep). No timeout fixes this, since the
// request never hangs, it's rejected outright. This is transient and
// retryable by nature (the container finishes booting within a handful of
// seconds), so a short bounded retry-with-backoff on 429 (and the other
// classic "upstream not ready yet" statuses, 502/503/504) is the correct
// fix -- distinct from a genuine, permanent non-2xx (401/404/etc), which
// still fails immediately, once, exactly as before.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
// 6 retries at base 1s doubling (1+2+4+8+16+32 = 63s of accumulated backoff)
// -- comfortably covers this same file's own documented "30-60s to wake"
// worst case. Verified live: a real end-to-end discovery call against a
// fully cold backend+messaging pair took 34s and succeeded once this budget
// was in place; the previous 4-retry/15s-total budget was too tight to
// reliably survive the documented worst case and could still surface the
// failure to the end user on a slow wake.
const MAX_RETRIES = 6;
const RETRY_BASE_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

@Injectable()
export class CoreIntegrationService {
  private readonly logger = new Logger(CoreIntegrationService.name);
  private readonly baseUrl: string;
  private readonly internalKey: string;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(configService: ConfigService) {
    this.baseUrl = configService.get<string>('coreIntegration.baseUrl')!;
    this.internalKey = configService.get<string>(
      'coreIntegration.internalKey',
    )!;
  }

  async getParentRelationships(personId: string): Promise<string[]> {
    return this.cached(`parent:${personId}`, async () => {
      const body = await this.get<{ relatedPersonIds: string[] }>(
        `/relationships/parent/${personId}`,
      );
      return body.relatedPersonIds;
    });
  }

  async getFacultyRelationships(personId: string): Promise<string[]> {
    return this.cached(`faculty:${personId}`, async () => {
      const body = await this.get<{ relatedPersonIds: string[] }>(
        `/relationships/faculty/${personId}`,
      );
      return body.relatedPersonIds;
    });
  }

  async getWardenRelationships(personId: string): Promise<string[]> {
    return this.cached(`warden:${personId}`, async () => {
      const body = await this.get<{ relatedPersonIds: string[] }>(
        `/relationships/warden/${personId}`,
      );
      return body.relatedPersonIds;
    });
  }

  async getUserProjection(
    personId: string,
  ): Promise<CoreUserProjection | null> {
    return this.cached(`user:${personId}`, async () => {
      const body = await this.get<{ data: CoreUserProjection | null }>(
        `/users/${personId}`,
      );
      return body.data;
    });
  }

  /** Batched counterpart to getUserProjection -- ONE (or a few, chunked)
   * request instead of firing getUserProjection once per id. Directory
   * discovery's scoped-contacts resolution can need hundreds of these at
   * once (e.g. a Class Advisor's full section roster); doing that as N
   * parallel single-id calls was exhausting Core's DB connection pool and
   * crashing with a 500 under exactly that load. Not run through the
   * single-id cache (a batch is already one request), but each result is
   * also written into it so a subsequent single-id lookup for the same
   * person within the TTL is still a cache hit. */
  async getUserProjectionsBatch(
    personIds: string[],
  ): Promise<Map<string, CoreUserProjection>> {
    const result = new Map<string, CoreUserProjection>();
    if (personIds.length === 0) return result;

    const CHUNK_SIZE = 200;
    for (let i = 0; i < personIds.length; i += CHUNK_SIZE) {
      const chunk = personIds.slice(i, i + CHUNK_SIZE);
      const body = await this.post<{ data: CoreUserProjection[] }>(
        '/users/batch',
        { personIds: chunk },
      );
      const now = Date.now();
      for (const projection of body.data) {
        result.set(projection.personId, projection);
        this.cache.set(`user:${projection.personId}`, {
          value: projection,
          expiresAt: now + CACHE_TTL_MS,
        });
      }
    }
    return result;
  }

  async listMessagingUsers(params: {
    cursor?: string;
    limit: number;
    excludePersonId?: string;
  }): Promise<ListMessagingUsersResult> {
    // Deliberately NOT cached — this is a paginated listing, not a single-actor
    // lookup repeated within one request.
    const query = new URLSearchParams();
    query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.excludePersonId)
      query.set('excludePersonId', params.excludePersonId);
    const body = await this.get<{
      data: CoreUserProjection[];
      nextCursor: string | null;
    }>(`/users?${query.toString()}`);
    return { items: body.data, nextCursor: body.nextCursor };
  }

  /** Real Expo push tokens already registered for this person via Core's own
   * device-token endpoint — used only by the outbox push worker, never by
   * authorization logic. */
  async getPushTokens(personId: string): Promise<string[]> {
    const body = await this.get<{ tokens: string[] }>(
      `/users/${personId}/push-tokens`,
    );
    return body.tokens;
  }

  private async cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = this.cache.get(key);
    if (entry && entry.expiresAt > now) {
      return entry.value as T;
    }
    const value = await fetcher();
    this.cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'X-Internal-Service-Key': this.internalKey,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        if (!response.ok) {
          if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
            this.logger.warn(
              `Core integration call ${method} ${path} got ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, likely Core still waking up) — retrying in ${delay}ms`,
            );
            await sleep(delay);
            continue;
          }
          throw new HttpException(
            `Core integration returned ${response.status}`,
            response.status,
          );
        }
        return (await response.json()) as T;
      } catch (err) {
        // AbortError (our own timeout) is retried the same as a retryable
        // status -- Core mid-wake-up can also just hang past the timeout on
        // an early attempt, and a hung request is exactly as transient as a
        // 429/502/503 here.
        const isAbort = err instanceof Error && err.name === 'AbortError';
        if (isAbort && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
          this.logger.warn(
            `Core integration call ${method} ${path} timed out (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying in ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }
        this.logger.error(
          `Core integration call failed: ${method} ${path} — ${err instanceof Error ? err.message : err}`,
        );
        throw new CoreIntegrationUnavailableError(path, err);
      } finally {
        clearTimeout(timeout);
      }
    }
    // Unreachable -- the loop above always either returns or throws.
    throw new CoreIntegrationUnavailableError(path, new Error('retry loop exhausted'));
  }
}
