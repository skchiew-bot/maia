import {
  EVENT_CATALOG,
  type EventType,
  type EvidenceEventLine,
  type EvidenceEventRef,
  type EvidenceMetaEntry,
  type MetaOf,
  type StoredEvent,
} from '@aoc/contracts';
import { EventStore, type ListQuery } from '@aoc/kernel';

const BATCH = 5000;

/** Page through store.list by seq (list() caps a single call). */
export function* iterateEvents(
  store: EventStore,
  q: Omit<ListQuery, 'limit' | 'order'>,
): Generator<StoredEvent> {
  let from = q.fromSeq ?? 1;
  for (;;) {
    const page = store.list({ ...q, fromSeq: from, limit: BATCH, order: 'asc' });
    yield* page;
    if (page.length < BATCH) return;
    from = page[page.length - 1]!.seq + 1;
  }
}

export function metaOf<T extends EventType>(e: StoredEvent, _type: T): MetaOf<T> {
  return e.meta as unknown as MetaOf<T>;
}

export function typesWithPrefix(prefix: string): string[] {
  return [...EVENT_CATALOG.keys()].filter((t) => t.startsWith(prefix));
}

export function refOf(e: StoredEvent): EvidenceEventRef {
  return { seq: e.seq, id: e.id, type: e.type, ts: e.ts };
}

export function entryOf(e: StoredEvent): EvidenceMetaEntry {
  return { seq: e.seq, id: e.id, ts: e.ts, meta: e.meta };
}

/** The chained header of an event: everything the hash covers except the payload body itself. */
export function lineOf(e: StoredEvent): EvidenceEventLine {
  return {
    ...EventStore.headerOf(e),
    payloadHash: e.payloadHash,
    bodyScope: e.bodyScope,
    source: e.source,
    sourceTs: e.sourceTs,
    idempotencyKey: e.idempotencyKey,
    causationId: e.causationId,
    prevHash: e.prevHash,
    hash: e.hash,
  };
}

/** Evenly spread sample (keeps both ends) of at most n items. */
export function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  if (n <= 1) return items.slice(0, n);
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]!);
}
