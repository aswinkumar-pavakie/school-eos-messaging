// Strips empty-string query values to undefined before class-validator sees them
// (an empty `?before=` from a client still reaches @IsOptional() @IsUUID() as `''`,
// not `undefined`, and fails validation even though "no cursor" was clearly meant).
// Scoped to query params only — copied from school-eos-backend's own convention.

import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class EmptyQueryValuePipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type === 'query' && value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === '') {
          delete (value as Record<string, unknown>)[key];
        }
      }
    }
    return value;
  }
}
