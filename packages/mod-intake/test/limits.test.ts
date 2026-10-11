import { afterEach, describe, expect, it } from 'vitest';
import { INTAKE_ENVELOPE_BYTES, intakeRequestBytes, type IntakeLimits } from '@aoc/contracts';
import { bodyLimitFor, createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { builtinScanner, createIntakeModule, intakeLimits } from '../src';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);

let t: TestRuntime;
afterEach(async () => t?.close());

async function setup() {
  t = await createTestRuntime({
    modules: [createIntakeModule({ scanner: builtinScanner })],
    config: { intake: { maxImageBytes: 1024, maxVideoBytes: 4096, maxAttachments: 3 } },
  });
  t.rt.store.append({
    type: 'project.created',
    actor: { kind: 'system', id: 'test' },
    scope: { projectId: 'prj_1' },
    meta: { projectId: 'prj_1', slug: 'claims' },
    payload: { name: 'Claims' },
    source: 'system',
  });
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
    expect(limits.accepted.find((a) => a.mime === 'video/quicktime')).toEqual({
      mime: 'video/quicktime',
      kind: 'video',
      extensions: ['.mov'],
    });
    expect(
      (await t.request('GET', '/portal/api/limits', { headers: t.user('approver').headers })).status,
    ).toBe(200);
  });

  it('publishes the total that the request-body cap on the upload route enforces (one source of truth)', async () => {
    await setup();
    const { headers } = t.user('requester');
    const limits = await t.json<IntakeLimits>('GET', '/portal/api/limits', { headers });
    expect(limits.maxTotalBytes).toBe(intakeLimits(t.config.intake).maxTotalBytes);

    // The kernel's cap on the upload route is that total plus the form envelope, not attachments x the largest file.
    const cap = limits.maxTotalBytes + INTAKE_ENVELOPE_BYTES;
    expect(cap).toBeLessThan(limits.maxAttachments * limits.maxBytes.video + INTAKE_ENVELOPE_BYTES);
    expect(bodyLimitFor('/portal/api/intakes', t.config)).toBe(cap);
    expect(intakeRequestBytes(t.config.intake)).toBe(cap);

    // And a real request meets the same number: one byte over is refused before anything is read or authenticated.
    const upload = (declared: number, auth: Record<string, string> = headers) =>
      t.app.request('/portal/api/intakes', {
        method: 'POST',
        headers: { ...auth, 'content-length': String(declared) },
        body: 'x',
      });
    const over = await upload(cap + 1, {});
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe('payload_too_large');
    expect((await upload(cap + 1)).status).toBe(413);
    expect((await upload(cap, {})).status).toBe(401); // within the cap, so it reaches authentication
    expect(t.rt.store.list({ typePrefix: 'intake.' })).toHaveLength(0);
  });

  it('is refused without the submit permission', async () => {
    await setup();
    expect(
      (await t.request('GET', '/portal/api/limits', { headers: t.user('builder').headers })).status,
    ).toBe(403);
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
    const tooMany = Array.from(
      { length: limits.maxAttachments + 1 },
      (_, i) => new File([PNG], `s${i}.png`, { type: 'image/png' }),
    );
    expect((await submit('Too many files', tooMany)).status).toBe(413);
    const big = new File([Buffer.concat([PNG, Buffer.alloc(limits.maxBytes.image)])], 'big.png', {
      type: 'image/png',
    });
    expect((await submit('Big screenshot', [big])).status).toBe(413);
    expect((await submit('One screenshot', [new File([PNG], 'ok.png', { type: 'image/png' })])).status).toBe(
      201,
    );
  });
});

describe('intake submissions per Requester (O-16)', () => {
  const submitAs = (headers: Record<string, string>, title: string) => {
    const fd = new FormData();
    fd.set('title', title);
    fd.set('description', 'The claim form goes blank after I attach a file.');
    return t.app.request('/portal/api/intakes', { method: 'POST', headers, body: fd });
  };

  it('answers 429 with Retry-After once a Requester has used the hour, before reading the form, leaving other Requesters alone (O-16, G-47)', async () => {
    t = await createTestRuntime({
      modules: [createIntakeModule({ scanner: builtinScanner, submissionLimits: { perRequesterPerHour: 2 } })],
    });
    t.rt.store.append({
      type: 'project.created',
      actor: { kind: 'system', id: 'test' },
      scope: { projectId: 'prj_1' },
      meta: { projectId: 'prj_1', slug: 'claims' },
      payload: { name: 'Claims' },
      source: 'system',
    });
    const a = t.user('requester').headers;
    const b = t.user('requester').headers;
    expect((await submitAs(a, 'First report')).status).toBe(201);
    // a submission the route rejects still counts
    expect((await submitAs(a, 'x')).status).toBe(422);
    const limited = await submitAs(a, 'Third report');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('3600');
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    // refused before the form is read: even a body that is not a form gets 429, not 400/422
    expect(
      (await t.app.request('/portal/api/intakes', { method: 'POST', headers: { ...a, 'content-type': 'multipart/form-data; boundary=x' }, body: 'not a form' })).status,
    ).toBe(429);
    expect((await submitAs(b, 'Another requester')).status).toBe(201);
    expect(t.rt.store.list({ types: ['intake.submitted'] })).toHaveLength(2);
    t.clock.advance(3_600_000); // the first submission leaves the rolling hour
    expect((await submitAs(a, 'Next hour')).status).toBe(201);
  });
});

describe('portal uploads are read as a stream (O-16)', () => {
  const BOUNDARY = 'aocTestBoundary';
  const fieldPart = (name: string, value: string) =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const filePart = (name: string, type: string) =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`;
  const textFields = fieldPart('title', 'Blank form') + fieldPart('description', 'The claim form goes blank after I attach a file.');

  /** A body that sends `head` and then never ends: a route that waited for the whole form would never answer. */
  function endless(head: Buffer) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(head));
      },
      pull: () => new Promise<void>(() => {}),
      cancel() {
        cancelled = true;
      },
    });
    return { body, cancelled: () => cancelled };
  }
  const post = (headers: Record<string, string>, body: ReadableStream<Uint8Array> | string) =>
    t.app.request('/portal/api/intakes', {
      method: 'POST',
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body,
      duplex: 'half',
    } as RequestInit);

  it('refuses a file whose magic bytes are not an accepted type before the rest of the request arrives (O-16, G-47)', async () => {
    await setup();
    const { headers } = t.user('requester');
    const upload = endless(Buffer.concat([Buffer.from(textFields + filePart('run.png', 'image/png')), Buffer.from('#!/bin/sh\necho owned\n')]));
    const res = await post(headers, upload.body);
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: { code: 'unsupported_media' } });
    expect(upload.cancelled()).toBe(true);
    expect(t.rt.store.list({ types: ['intake.submitted'] })).toHaveLength(0);
  });

  it('refuses a file once it passes the cap for its kind, without reading the rest (O-16, G-47)', async () => {
    await setup(); // images are capped at 1024 bytes here
    const { headers } = t.user('requester');
    const upload = endless(Buffer.concat([Buffer.from(textFields + filePart('big.png', 'image/png')), PNG, Buffer.alloc(1100)]));
    const res = await post(headers, upload.body);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'too_large' } });
    expect(upload.cancelled()).toBe(true);
  });

  it('refuses one file too many at its first byte (O-16, G-47)', async () => {
    await setup(); // at most 3 attachments here
    const { headers } = t.user('requester');
    const three = [1, 2, 3].map((i) => Buffer.concat([Buffer.from(filePart(`s${i}.png`, 'image/png')), PNG, Buffer.from('\r\n')]));
    const upload = endless(Buffer.concat([Buffer.from(textFields), ...three, Buffer.from(filePart('s4.png', 'image/png')), PNG.subarray(0, 1)]));
    const res = await post(headers, upload.body);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'too_many_files' } });
    expect(upload.cancelled()).toBe(true);
  });

  it('answers 400 for a body that is not a valid multipart form, and 415 for one that is not multipart at all', async () => {
    await setup();
    const { headers } = t.user('requester');
    const malformed = await post(headers, 'not a form');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'invalid_form' } });
    const json = await t.app.request('/portal/api/intakes', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
    expect(json.status).toBe(415);
    expect(t.rt.store.list({ types: ['intake.submitted'] })).toHaveLength(0);
  });
});
