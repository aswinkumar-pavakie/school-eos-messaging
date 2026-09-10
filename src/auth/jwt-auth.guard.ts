// Global Bearer-token guard, registered once via APP_GUARD in app.module.ts —
// never attached per-controller, so a new controller can't accidentally ship
// unauthenticated (LLD §8/§82).
//
// Verifies the SAME JWT Core issues (identical payload shape { sub, roles },
// identical shared secret via JWT_ACCESS_SECRET) — Messaging never issues its
// own tokens, per the explicit decision recorded in the approved plan.
//
// Non-negotiable: any failure here — missing header, bad signature, expired
// token, even a bug in this file — must DENY the request. There is no code path
// that returns true except "the token verified". Everything else, including
// unexpected exceptions, falls through to the catch block and throws
// UnauthorizedException (LLD §71: no fallback to permissive behavior).
//
// What this guard does NOT do — and why that's still safe (documented
// assumption, "explicit revocation path" from the plan): a stateless JWT
// verified here can't reflect a logout/role-change that happened in Core after
// the token was issued, for up to its short (~15 min) natural expiry — the same
// exposure window Core's own REST APIs already accept for the same tokens, not
// a new gap Messaging introduces. What Messaging does NOT rely on the stale JWT
// for: (a) every messaging-authorization-sensitive decision re-derives current
// relationship/messagingEnabled state live from Core (see core-integration/,
// relationships/) and fails closed if Core disagrees with the token's roles
// claim; (b) device revocation — the one case explicitly requiring an
// *immediate* disconnect (LLD §49) — is entirely Messaging-owned state
// (messaging_devices.status), checked independently on every WebSocket
// connect/heartbeat in the websocket/ gateway, not derived from the JWT at all.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthenticatedUser } from './authenticated-user.interface';
import { IS_PUBLIC_KEY } from './public.decorator';

interface AccessTokenPayload {
  sub: string;
  roles: string[];
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const isPublic = this.reflector.getAllAndOverride<boolean>(
        IS_PUBLIC_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (isPublic) {
        return true;
      }

      const request = context.switchToHttp().getRequest<Request>();
      const token = this.extractBearerToken(request);
      if (!token) {
        throw new UnauthorizedException();
      }

      const user = await this.verifyToken(token);
      (request as Request & { user: AuthenticatedUser }).user = user;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }

  /** Shared by the HTTP guard above and the WebSocket gateway's own connect-time
   * handshake authentication (Socket.IO has no CanActivate-style HTTP guard
   * pipeline of its own) — one verification path, never two copies. */
  async verifyToken(token: string): Promise<AuthenticatedUser> {
    const payload =
      await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    if (!payload?.sub || !Array.isArray(payload.roles)) {
      throw new UnauthorizedException();
    }
    return { personId: payload.sub, roles: payload.roles };
  }

  private extractBearerToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' && token ? token : undefined;
  }
}
