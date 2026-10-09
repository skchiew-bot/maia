import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('operator routes (§6: owners drive their own sessions, Approvers drive any)', () => {
  it('lets the owner and an Approver drive a session, but not another Builder', async () => {
    h = await createHarness();
    const launched = await h.t.json<{ sessionId: string }>('POST', '/api/sessions', {
      headers: h.owner.headers,
      body: { processType: 'feature-build', projectId: 'prj_demo', prompt: 'Build it' },
      expect: 201,
    });
    const id = launched.sessionId;
    await h.waitLifecycle(id, 'idle');
    expect(h.sup.session(id)!.ownerId).toBe(h.owner.user.id);

    const other = h.t.user('builder', 'Someone else');
    for (const [path, body] of [
      ['prompt', { text: 'x' }],
      ['nudge', { text: 'x' }],
      ['restart', undefined],
      ['stop', {}],
    ] as const) {
      const res = await h.t.request('POST', `/api/sessions/${id}/${path}`, { headers: other.headers, body });
      expect(res.status, path).toBe(403);
    }
    expect((await h.t.request('POST', `/api/sessions/${id}/prompt`, { body: { text: 'x' } })).status).toBe(
      401,
    );
    expect(
      (
        await h.t.request('POST', '/api/sessions/ses_unknown/prompt', {
          headers: h.owner.headers,
          body: { text: 'x' },
        })
      ).status,
    ).toBe(404);

    await h.t.json('POST', `/api/sessions/${id}/prompt`, {
      headers: h.owner.headers,
      body: { text: 'Add a logout button' },
    });
    await h.waitFor(() => h!.callsFor(id).length === 2, 'operator prompt turn');
    await h.waitLifecycle(id, 'idle');
    expect(h.callsFor(id)[1]!.prompt).toBe('Add a logout button');
    expect(h.events('session.turn_started', id)[1]!.actor).toEqual(h.ownerActor);

    const approver = h.t.user('approver');
    await h.t.json('POST', `/api/sessions/${id}/nudge`, {
      headers: approver.headers,
      body: { text: 'Wrap up' },
    });
    await h.waitFor(() => h!.callsFor(id).length === 3, 'nudge turn');
    await h.waitLifecycle(id, 'idle');
    expect(h.events('session.nudged', id)[0]!.actor).toEqual({ kind: 'human', id: approver.user.id });

    await h.t.json('POST', `/api/sessions/${id}/restart`, { headers: h.owner.headers });
    await h.waitFor(() => h!.callsFor(id).length === 4, 'restart turn');
    await h.waitLifecycle(id, 'idle');

    await h.t.json('POST', `/api/sessions/${id}/stop`, { headers: h.owner.headers });
    expect(h.lifecycle(id)).toBe('ended');
    expect(h.events('session.stop_requested', id)[0]!.meta).toEqual({ sessionId: id, immediate: false });
  });

  it('accepts prompts only while the session waits on its operator, and validates bodies', async () => {
    h = await createHarness();
    const id = await h.launch('[[fake:hang]] busy');
    await h.waitFor(() => h!.callsFor(id).length === 1, 'running');
    const res = await h.t.request('POST', `/api/sessions/${id}/prompt`, {
      headers: h.owner.headers,
      body: { text: 'hello' },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_resumable');
    expect(
      (
        await h.t.request('POST', `/api/sessions/${id}/nudge`, {
          headers: h.owner.headers,
          body: { text: '' },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await h.t.request('POST', `/api/sessions/${id}/stop`, {
          headers: h.owner.headers,
          body: { immediate: 'yes' },
        })
      ).status,
    ).toBe(422);
    await h.t.json('POST', `/api/sessions/${id}/stop`, {
      headers: h.owner.headers,
      body: { immediate: true, reason: 'wrong branch' },
    });
    await h.waitLifecycle(id, 'ended');
    expect(h.payload(h.events('session.stop_requested', id)[0]!)).toEqual({ reason: 'wrong branch' });
    expect(
      (
        await h.t.request('POST', `/api/sessions/${id}/prompt`, {
          headers: h.owner.headers,
          body: { text: 'hello' },
        })
      ).status,
    ).toBe(409);
  });
});
