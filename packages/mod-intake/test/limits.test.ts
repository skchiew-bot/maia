import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeLimits } from '@aoc/contracts';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { builtinScanner, createIntakeModule } from '../src';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);

let t: TestRuntime;
afterEach(async () => t?.close());

async function setup() {
  t = await createTestRuntime({
    modules: [createIntakeModule({ scanner: builtinScanner })],
    config: { intake: { maxImageBytes: 1024, maxVideoBytes: 4096, maxAttachments: 3 } },
  });
  t.rt.store.append({ type: 'project.created', actor: { kind: 'system', id: 'test' }, scope: { projectId: 'prj_1' }, meta: { projectId: 'prj_1', slug: 'claims' }, payload: { name: 'Claims' }, source: 'system' });
}

describe('GET /portal/api/limits', () => {
  it('publishes the configured upload rules to anyone who may submit', async () => {
    await setup();
    const requester = t.user('requester');
    const limits = await t.json<IntakeLimits>('GET', '/portal/api/limits', { headers: requester.headers });
    expect(limits).toMatchObject({
      maxAttachments: 3,
      maxBytes: { image: 1024, video: 4096, document: 1024 },
      maxTotalBytes: 4096,
      titleLength: { min: 3, max: 200 },
      descriptionLength: { min: 10, max: 20_000 },
    });
    expect(limits.accepted.map((a) => a.mime)).toEqual([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'application/pdf',
    ]);
    expect(limits.accepted.find((a) => a.mime === 'video/quicktime')).toEqual({ mime: 'video/quicktime', kind: 'video', extensions: ['.mov'] });
    expect((await t.request('GET', '/portal/api/limits', { headers: t.user('approver').headers })).status).toBe(200);
  });

  it('is refused without the submit permission', async () => {
    await setup();
    expect((await t.request('GET', '/portal/api/limits', { headers: t.user('builder').headers })).status).toBe(403);
    expect((await t.request('GET', '/portal/api/limits')).status).toBe(401);
  });

  it('matches what the intake route enforces', async () => {
    await setup();
    const { headers } = t.user('requester');
    const limits = await t.json<IntakeLimits>('GET', '/portal/api/limits', { headers });
    const submit = (title: string, files: File[] = []) => {
      const fd = new FormData();
      fd.set('title', title);
      fd.set('description', 'The claim form goes blank after I attach a file.');
      for (const f of files) fd.append('files', f);
      return t.app.request('/portal/api/intakes', { method: 'POST', headers, body: fd });
    };
    expect((await submit('x'.repeat(limits.titleLength.min - 1))).status).toBe(422);
    expect((await submit('x'.repeat(limits.titleLength.max + 1))).status).toBe(422);
    const tooMany = Array.from({ length: limits.maxAttachments + 1 }, (_, i) => new File([PNG], `s${i}.png`, { type: 'image/png' }));
    expect((await submit('Too many files', tooMany)).status).toBe(413);
    const big = new File([Buffer.concat([PNG, Buffer.alloc(limits.maxBytes.image)])], 'big.png', { type: 'image/png' });
    expect((await submit('Big screenshot', [big])).status).toBe(413);
    expect((await submit('One screenshot', [new File([PNG], 'ok.png', { type: 'image/png' })])).status).toBe(201);
  });
});
