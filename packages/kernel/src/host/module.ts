import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import type { AocConfig, AuthContext, IngestPrincipal, JsonValue, Notification, PreToolGuard, StoredEvent } from '@aoc/contracts';
import type { Clock } from '../clock';
import type { Logger } from '../logger';
import type { EventStore, Projector } from '../store/event-store';
import type { ServiceRegistry } from './services';

export interface ModuleContext {
  config: AocConfig;
  store: EventStore;
  db: DatabaseSync;
  clock: Clock;
  log: Logger;
  services: ServiceRegistry;
  dataDir: string;
  notify(n: Notification): void;
}

export interface Reactor {
  name: string;
  handles: readonly string[];
  /** At-least-once delivery after commit (cursor-tracked) — MUST be idempotent (check store.findByCausation). */
  react(e: StoredEvent, payload: JsonValue | null, ctx: ModuleContext): void | Promise<void>;
}

export type JobSchedule = { everyMs: number } | { dailyAt: string };
export interface Job {
  name: string;
  schedule: JobSchedule;
  run(ctx: ModuleContext): void | Promise<void>;
}

export type AppEnv = {
  Variables: {
    auth: AuthContext | null;
    ingest: IngestPrincipal | null;
    requestId: string;
  };
};
export type App = Hono<AppEnv>;

/** A module's entry in GET /api/health: machine labels, enums, numbers and booleans only — never paths or secrets. */
export interface ModuleHealth {
  /** false marks aocd degraded. */
  ok: boolean;
  detail: Record<string, JsonValue>;
}

/**
 * A domain module. Lifecycle: projectors registered → init (provide services) → routes mounted →
 * start (all services available) → jobs scheduled; on the way out quiesce (the API still serves), then stop.
 * Export a factory `createXModule(opts)`.
 */
export interface AocModule {
  name: string;
  projectors?: Projector[];
  reactors?: Reactor[];
  guards?: PreToolGuard[];
  jobs?: Job[];
  init?(ctx: ModuleContext): void | Promise<void>;
  routes?(app: App, ctx: ModuleContext): void;
  start?(ctx: ModuleContext): void | Promise<void>;
  /**
   * First phase of a stop, before the HTTP server stops accepting: wind down whatever still reports to this process
   * through its API (the supervisor lets its sidecars send their last usage). Bounded by the module; once, last
   * module first.
   */
  quiesce?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  /** Status of something the module depends on outside the log (e.g. the intake malware scanner), after init. */
  health?(): ModuleHealth;
}
