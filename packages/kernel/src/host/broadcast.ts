import type { EventHeader, LivenessState, Notification, Notifier, Role } from '@aoc/contracts';

export type BroadcastMessage =
  | { event: 'aoc'; data: EventHeader }
  | { event: 'liveness'; data: { sessionId: string; state: LivenessState | null; reason: string; since: string } }
  | { event: 'notification'; data: Notification & { id: string; at: string } }
  | { event: 'activity'; data: { sessionId: string; kind: 'tool' | 'stream' | 'mcp'; at: string } };

export interface Subscriber {
  /** Roles allowed to receive this subscriber's messages (requesters get nothing internal). */
  role: Role;
  send(m: BroadcastMessage): void;
}

/** In-process fan-out hub feeding SSE connections (daemon) and tests. */
export class Broadcaster implements Notifier {
  private readonly subs = new Set<Subscriber>();
  private n = 0;

  constructor(private readonly nowIso: () => string) {}

  subscribe(s: Subscriber): () => void {
    this.subs.add(s);
    return () => this.subs.delete(s);
  }

  publish(m: BroadcastMessage): void {
    for (const s of this.subs) {
      if (s.role === 'requester') continue;
      if (m.event === 'notification' && !m.data.audience.includes(s.role)) continue;
      try {
        s.send(m);
      } catch {
        this.subs.delete(s);
      }
    }
  }

  notify(n: Notification): void {
    this.publish({ event: 'notification', data: { ...n, id: `ntf_${++this.n}`, at: this.nowIso() } });
  }

  get size(): number {
    return this.subs.size;
  }
}
