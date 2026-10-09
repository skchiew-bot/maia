import { Worker } from 'node:worker_threads';

export interface SnapshotFacts {
  chainId: string | null;
  headSeq: number;
  headHash: string | null;
  bodies: number;
  /** Events with a payload whose body is absent although their scope was never erased. */
  bodiesMissing: number;
  blobs: { scope: string; blobId: string }[];
  aocDbBytes: number;
  bodiesDbBytes: number;
}

/**
 * Runs in a worker thread (node:sqlite is synchronous): `VACUUM INTO` on separate read-only connections gives a
 * transactionally consistent, compacted copy of each database — free pages holding scrubbed text are not carried
 * into the backup — while aocd's event loop keeps serving. aoc.db is copied first: a body commits before its event,
 * so every event in the first copy has its body in the second (a body without its event is harmless).
 */
const WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { statSync } = require('node:fs');
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
  const message = typeof warning === 'string' ? warning : warning && warning.message;
  if (type === 'ExperimentalWarning' && /SQLite/.test(String(message))) return;
  emitWarning(warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
function vacuumInto(src, dest) {
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(dest);
  } finally {
    db.close();
  }
}
try {
  const { aocDb, bodiesDb, aocOut, bodiesOut } = workerData;
  vacuumInto(aocDb, aocOut);
  vacuumInto(bodiesDb, bodiesOut);
  const db = new DatabaseSync(aocOut);
  try {
    db.prepare('ATTACH DATABASE ? AS b').run(bodiesOut);
    const chain = db.prepare("SELECT v FROM chain_info WHERE k = 'chain_id'").get();
    const head = db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1').get();
    const missing = db
      .prepare(
        'SELECT COUNT(*) AS n FROM events e WHERE e.payload_hash IS NOT NULL' +
          ' AND NOT EXISTS (SELECT 1 FROM b.bodies x WHERE x.event_id = e.id)' +
          ' AND NOT EXISTS (SELECT 1 FROM b.body_keys k WHERE k.scope = e.body_scope AND k.destroyed_at IS NOT NULL)',
      )
      .get();
    const bodies = db.prepare('SELECT COUNT(*) AS n FROM b.bodies').get();
    const blobs = db.prepare('SELECT scope, blob_id FROM b.blobs ORDER BY scope, blob_id').all();
    db.exec('DETACH DATABASE b');
    parentPort.postMessage({
      ok: true,
      facts: {
        chainId: chain ? chain.v : null,
        headSeq: head ? head.seq : 0,
        headHash: head ? head.hash : null,
        bodies: bodies.n,
        bodiesMissing: missing.n,
        blobs: blobs.map((r) => ({ scope: r.scope, blobId: r.blob_id })),
        aocDbBytes: statSync(aocOut).size,
        bodiesDbBytes: statSync(bodiesOut).size,
      },
    });
  } finally {
    db.close();
  }
} catch (err) {
  parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
}
`;

export function takeSnapshot(
  paths: { aocDb: string; bodiesDb: string; aocOut: string; bodiesOut: string },
  signal?: AbortSignal,
): Promise<SnapshotFacts> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: paths });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      void worker.terminate();
      settle(() => reject(signal!.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (m: { ok: true; facts: SnapshotFacts } | { ok: false; error: string }) =>
      settle(() => (m.ok ? resolve(m.facts) : reject(new Error(m.error)))),
    );
    worker.once('error', (err) => settle(() => reject(err)));
    worker.once('exit', (code) => settle(() => reject(new Error(`snapshot worker exited with code ${code}`))));
  });
}
