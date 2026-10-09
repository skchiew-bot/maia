import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export const ACTOR_KINDS = ['human', 'agent', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
/** human: user id (usr_…); agent: AOC session id (ses_…); system: component name (e.g. "supervisor", "scheduler:fx"). */
export interface Actor {
  kind: ActorKind;
  id: string;
}
export const ActorSchema = z.object({ kind: z.enum(ACTOR_KINDS), id: z.string().min(1).max(128) }).strict();

/** Indexed scope columns. Only ids — never free text. */
export interface Scope {
  projectId?: string;
  threadId?: string;
  sessionId?: string;
  taskId?: string;
  ticketId?: string;
  changeId?: string;
  decisionId?: string;
  userId?: string;
}
export const ScopeSchema = z
  .object({
    projectId: z.string().max(64).optional(),
    threadId: z.string().max(64).optional(),
    sessionId: z.string().max(64).optional(),
    taskId: z.string().max(64).optional(),
    ticketId: z.string().max(64).optional(),
    changeId: z.string().max(64).optional(),
    decisionId: z.string().max(64).optional(),
    userId: z.string().max(64).optional(),
  })
  .strict();

export const EVENT_SOURCES = [
  'hook',
  'mcp',
  'sidecar',
  'supervisor',
  'api',
  'scheduler',
  'cli',
  'intake',
  'system',
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** What a writer hands to EventStore.append(). `ts`, `seq`, hashes are assigned by the store (sole writer). */
export interface NewEventInput<TType extends string = string, TMeta = JsonObject, TPayload = JsonValue | null> {
  type: TType;
  actor: Actor;
  scope?: Scope;
  /** Chained in clear. Ids / enums / numbers / hashes only (see CLAUDE.md event-sourcing rules). */
  meta: TMeta;
  /** Encrypted in the body store; only a blinded hash is chained. Omit/null for header-only events. */
  payload?: TPayload | null;
  source: EventSource;
  /** Timestamp at the source (for buffered / observed events), ISO-8601. */
  sourceTs?: string;
  /** Exactly-once guard for retries / spool flushes. A repeated key returns the original event. */
  idempotencyKey?: string;
  /** Id of the event that caused this one (reactor follow-ups). */
  causationId?: string;
  /** Encryption-key scope for the body (defaults: sessionId → ticketId → projectId → "global"). Erasing a scope crypto-shreds its bodies. */
  bodyScope?: string;
}

export interface StoredEvent<TType extends string = string, TMeta = JsonObject> {
  seq: number;
  id: string;
  ts: string;
  type: TType;
  actor: Actor;
  scope: Scope;
  meta: TMeta;
  payloadHash: string | null;
  bodyScope: string | null;
  source: EventSource;
  sourceTs: string | null;
  idempotencyKey: string | null;
  causationId: string | null;
  prevHash: string;
  hash: string;
}

/** Header-only view streamed to the console over SSE (`event: aoc`). */
export interface EventHeader {
  seq: number;
  id: string;
  ts: string;
  type: string;
  actor: Actor;
  scope: Scope;
  meta: JsonObject;
}
