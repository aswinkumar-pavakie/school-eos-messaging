// @Public() exempts a route from the global JwtAuthGuard. Used only on
// /health/* (no identity to verify yet) — every real messaging route requires
// a verified actor, with no exceptions (LLD §7/§82).

import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
