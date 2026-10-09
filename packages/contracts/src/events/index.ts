import { z } from 'zod';
import { AUDIT_EVENTS } from './audit';
import { CHANGE_EVENTS } from './change';
import { CORE_EVENTS } from './core';
import { CREDIT_EVENTS } from './credits';
import type { EventDefinition, EventMapOf } from './define';
import { EVIDENCE_EVENTS } from './evidence';
import { FX_EVENTS } from './fx';
import { IDENTITY_EVENTS } from './identity';
import { INTAKE_EVENTS } from './intake';
import { LEARNING_EVENTS } from './learning';
import { LEDGER_EVENTS } from './ledger';
import { METERING_EVENTS } from './metering';
import { REGISTRY_EVENTS } from './registry';

export * from './define';
export * from './core';
export * from './ledger';
export * from './change';
export * from './identity';
export * from './metering';
export * from './fx';
export * from './credits';
export * from './learning';
export * from './registry';
export * from './audit';
export * from './evidence';
export * from './intake';

export const ALL_EVENTS = [
  ...CORE_EVENTS,
  ...LEDGER_EVENTS,
  ...CHANGE_EVENTS,
  ...IDENTITY_EVENTS,
  ...METERING_EVENTS,
  ...FX_EVENTS,
  ...CREDIT_EVENTS,
  ...LEARNING_EVENTS,
  ...REGISTRY_EVENTS,
  ...AUDIT_EVENTS,
  ...EVIDENCE_EVENTS,
  ...INTAKE_EVENTS,
] as const;

export type EventMap = EventMapOf<typeof ALL_EVENTS>;
export type EventType = keyof EventMap;
export type MetaOf<T extends EventType> = EventMap[T]['meta'];
export type PayloadOf<T extends EventType> = EventMap[T]['payload'];

export const EVENT_CATALOG: ReadonlyMap<string, EventDefinition> = new Map(
  (ALL_EVENTS as readonly EventDefinition[]).map((d) => [d.type, d]),
);
if (EVENT_CATALOG.size !== ALL_EVENTS.length) {
  throw new Error('duplicate event type in catalog');
}

export function isEventType(t: string): t is EventType {
  return EVENT_CATALOG.has(t);
}

/** Validate meta (strict) and payload against the catalog. Returns a list of problems (empty = valid). */
export function validateEvent(type: string, meta: unknown, payload: unknown): string[] {
  const def = EVENT_CATALOG.get(type);
  if (!def) return [`unknown event type: ${type}`];
  const problems: string[] = [];
  const m = def.meta.safeParse(meta);
  if (!m.success) problems.push(...m.error.issues.map((i: z.ZodIssue) => `meta.${i.path.join('.')}: ${i.message}`));
  if (def.payload === null) {
    if (payload !== undefined && payload !== null) problems.push(`${type} is header-only; payload not allowed`);
  } else {
    const p = def.payload.safeParse(payload);
    if (!p.success) problems.push(...p.error.issues.map((i: z.ZodIssue) => `payload.${i.path.join('.')}: ${i.message}`));
  }
  return problems;
}
