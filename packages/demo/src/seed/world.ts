/**
 * Shared state of one seeding run: the runtime every module is driven through, the fake clock, the people and the
 * projects. The sections of the seed (history, learning, change control, tickets, "now") take this and nothing else.
 */
import type { Hono } from 'hono';
import type { Actor, AocConfig, Role, ServiceMap, ServiceName } from '@aoc/contracts';
import type { AocRuntime, AppEnv, EventStore, FakeClock } from '@aoc/kernel';
import type { ChangeModule } from '@aoc/mod-change';
import type { DemoLayout } from '../layout';
import type { Author } from './git';
import type { PasskeySigner } from './signer';
import type { SessionKit } from './sessions';
import type { SeedSupervisor } from './supervisor';

export type PersonKey = 'ceo' | 'aisyah' | 'weijie' | 'priya' | 'daniel' | 'nur';

export interface Person {
  key: PersonKey;
  userId: string;
  name: string;
  role: Role;
  token: string;
  /** Who a commit made by this person (or by their session) is attributed to. */
  author: Author;
}

export interface ProjectInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** The git working copy the project's sessions run in. */
  repo: string;
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

export const sys = (id: string): Actor => ({ kind: 'system', id });
export const human = (id: string): Actor => ({ kind: 'human', id });
export const agent = (id: string): Actor => ({ kind: 'agent', id });

/**
 * The kernel can replace a service but not remove one: `null` leaves `undefined` in its place, so `maybe` answers null
 * and `get` throws, exactly as when the module is not loaded.
 */
export function setService<K extends ServiceName>(rt: AocRuntime, name: K, impl: ServiceMap[K] | null): void {
  rt.services.override(name, (impl ?? undefined) as ServiceMap[K]);
}

/** Actions scheduled for a moment of the history, run in time order between the history's own sessions. */
export class Timeline {
  private readonly pending: { at: number; name: string; order: number; run: () => Promise<void> | void }[] = [];
  private count = 0;

  schedule(at: number, name: string, run: () => Promise<void> | void): void {
    this.pending.push({ at, name, order: this.count++, run });
    this.pending.sort((a, b) => a.at - b.at || a.order - b.order);
  }

  /** Runs every action due at or before `until`, each at its own time; the clock goes back to where the caller had it. */
  async runDue(until: number, clock: FakeClock): Promise<void> {
    while (this.pending.length && this.pending[0]!.at <= until) {
      const step = this.pending.shift()!;
      const resume = clock.now();
      clock.set(step.at);
      try {
        await step.run();
      } catch (err) {
        throw new Error(`seed step "${step.name}" failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      } finally {
        clock.set(resume);
      }
    }
  }

  get left(): string[] {
    return this.pending.map((p) => p.name);
  }
}

export interface SeedWorld {
  readonly now: number;
  readonly t0: number;
  readonly days: number;
  readonly tz: string;
  readonly layout: DemoLayout;
  readonly config: AocConfig;
  readonly rt: AocRuntime;
  readonly app: Hono<AppEnv>;
  readonly store: EventStore;
  readonly clock: FakeClock;
  readonly change: ChangeModule;
  readonly people: Record<PersonKey, Person>;
  readonly projects: { cx: ProjectInfo; claims: ProjectInfo; aoc: ProjectInfo };
  readonly kit: SessionKit;
  readonly signer: PasskeySigner;
  /** The `supervisor` service while history is written (see ./supervisor.ts). */
  readonly supervisor: SeedSupervisor;
  readonly timeline: Timeline;
  at(ms: number): void;
  /** Runs `fn` as when aocd has not started yet: intake cannot launch triage, so a new ticket stays in "received". */
  withoutSupervisor<T>(fn: () => Promise<T>): Promise<T>;
  api<T>(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; data: T }>;
  /** Like `api`, but a status of 300 or more is an error: the seed never continues past a refused request. */
  ok<T>(method: string, path: string, who: PersonKey, body?: unknown): Promise<T>;
  /** Reactors and the change module's background work (rollback verification) have settled. */
  settle(): Promise<void>;
}
