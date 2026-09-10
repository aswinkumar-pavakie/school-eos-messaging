// Which sockets, on THIS instance, belong to which person -- purely in-memory,
// purely local to one process (LLD §65: instances are stateless w.r.t.
// business data; this is just routing state for "who's connected to ME right
// now," rebuilt from nothing on every restart, never a source of truth for
// anything durable).

import { Injectable } from '@nestjs/common';
import type { Socket } from 'socket.io';

@Injectable()
export class ConnectionRegistryService {
  private readonly socketsByPerson = new Map<string, Set<Socket>>();

  add(personId: string, socket: Socket): void {
    const existing = this.socketsByPerson.get(personId);
    if (existing) existing.add(socket);
    else this.socketsByPerson.set(personId, new Set([socket]));
  }

  remove(personId: string, socket: Socket): void {
    const existing = this.socketsByPerson.get(personId);
    if (!existing) return;
    existing.delete(socket);
    if (existing.size === 0) this.socketsByPerson.delete(personId);
  }

  getSockets(personId: string): Socket[] {
    return [...(this.socketsByPerson.get(personId) ?? [])];
  }

  isConnectedLocally(personId: string): boolean {
    return this.socketsByPerson.has(personId);
  }
}
