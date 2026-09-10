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

const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5_000;

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { 'X-Internal-Service-Key': this.internalKey },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new HttpException(
          `Core integration returned ${response.status}`,
          response.status,
        );
      }
      return (await response.json()) as T;
    } catch (err) {
      this.logger.error(
        `Core integration call failed: GET ${path} — ${err instanceof Error ? err.message : err}`,
      );
      throw new CoreIntegrationUnavailableError(path, err);
    } finally {
      clearTimeout(timeout);
    }
  }
}
