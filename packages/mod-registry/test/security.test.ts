import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KnowledgeSearchResponse } from '@aoc/contracts';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { createRegistryModule } from '../src';
import { REGISTRY, writeRegistry } from './helpers';

let t: TestRuntime;
afterEach(async () => t?.close());

// Stem-stable under the porter tokenizer, so the probe matches what the FTS index actually stores.
const TOKEN = 'qzxwvkjbm';

describe('knowledge layer erasure (§13)', () => {
  it('leaves no trace of an erased document in the FTS index pages on disk', async () => {
    t = await createTestRuntime({ modules: [createRegistryModule()], config: { registryFile: writeRegistry(REGISTRY) }, onDisk: true });
    const lessonId = 'lsn_pdpa';
    t.rt.store.append({
      type: 'lesson.proposed',
      actor: { kind: 'system', id: 'learning' },
      scope: {},
      meta: { lessonId, classId: null, scopeType: 'process_type', scopeValue: 'bug-fix', decisionId: 'dec_lsn' },
      payload: { rule: `Never echo the customer name ${TOKEN} into logs`, fix: 'Mask names before logging' },
      source: 'system',
      bodyScope: lessonId,
    });
    t.rt.store.append({ type: 'lesson.bound', actor: { kind: 'human', id: 'usr_ceo' }, scope: {}, meta: { lessonId, decisionId: 'dec_lsn' }, source: 'system' });
    // pad the index so the erased document is not alone in its segment
    for (let i = 0; i < 40; i++) {
      const id = `lsn_pad${i}`;
      t.rt.store.append({
        type: 'lesson.proposed',
        actor: { kind: 'system', id: 'learning' },
        scope: {},
        meta: { lessonId: id, classId: null, scopeType: 'process_type', scopeValue: 'bug-fix', decisionId: `dec_${id}` },
        payload: { rule: `Run the migration dry-run first (${i})`, fix: 'Use the staging snapshot' },
        source: 'system',
        bodyScope: id,
      });
      t.rt.store.append({ type: 'lesson.bound', actor: { kind: 'human', id: 'usr_ceo' }, scope: {}, meta: { lessonId: id, decisionId: `dec_${id}` }, source: 'system' });
    }
    const builder = t.user('builder');
    const hit = await t.json<KnowledgeSearchResponse>('GET', `/api/knowledge/search?q=${TOKEN}`, { headers: builder.headers });
    expect(hit.results).toHaveLength(1);
    t.rt.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    t.rt.store.eraseScope(lessonId, { actor: { kind: 'human', id: 'usr_ceo' }, reason: 'pdpa_request' });

    const gone = await t.json<KnowledgeSearchResponse>('GET', `/api/knowledge/search?q=${TOKEN}`, { headers: builder.headers });
    expect(gone.results).toHaveLength(0);
    const files = ['aoc.db', 'aoc.db-wal'].map((f) => join(t.dataDir, f)).filter((p) => existsSync(p));
    expect(files.some((p) => readFileSync(p).includes(Buffer.from(TOKEN)))).toBe(false);
  });
});
