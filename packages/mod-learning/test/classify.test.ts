import { describe, expect, it } from 'vitest';
import type { LlmJsonRequest, OffenceDTO, RootCauseClassDTO } from '@aoc/contracts';
import { addSession, assignTo, createClass, errors, learningRuntime, report } from './helpers';

/** Scripted haiku: new class when none exist, else the first listed class; "flaky" errors get low confidence. */
function classifier(req: LlmJsonRequest) {
  if (req.prompt.includes('flaky')) return { classId: null, newClass: null, confidence: 0.2 };
  const id = req.prompt.match(/id: (rcc_[0-9A-Z]+)/)?.[1];
  if (!id)
    return {
      classId: null,
      newClass: {
        name: 'App config location undocumented in the spec',
        dimension: 'spec',
        description: 'Agents guess where config lives',
      },
      confidence: 0.9,
    };
  return { classId: id, newClass: null, confidence: 0.85 };
}

describe('root-cause clustering', () => {
  it('clusters different error texts into one cause via the AI suggestion (haiku), and leaves low confidence unassigned', async () => {
    const t = await learningRuntime();
    t.llm.on('learning.classify', classifier);
    const builder = t.user('builder');
    addSession(t, 'ses_a', 'bug-fix', 'claude-sonnet-5-5');
    const e1 = report(t, "Error: ENOENT: no such file or directory, open '/work/repo/config/app.json'", {
      sessionId: 'ses_a',
    });
    const e2 = report(t, 'Cannot start server: APP_CONFIG environment variable is not set', {
      sessionId: 'ses_a',
    });
    const e3 = report(t, 'flaky network blip while fetching registry', { sessionId: 'ses_a' });
    await t.drain();
    expect((await errors(t, builder.headers, '?unassigned=1')).length).toBe(3);

    await t.rt.runJob('learning.ai');
    const calls = t.llm.calls.filter((c) => c.purpose === 'learning.classify');
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.model === 'haiku')).toBe(true);
    expect(calls[0]!.prompt).toContain('<error>'); // untrusted text is fenced as data

    const all = await errors(t, builder.headers);
    const byId = new Map(all.map((e) => [e.errorId, e]));
    expect(byId.get(e1)!.signature).not.toBe(byId.get(e2)!.signature);
    expect(byId.get(e1)!.classId).toBeTruthy();
    expect(byId.get(e2)!.classId).toBe(byId.get(e1)!.classId);
    expect(byId.get(e1)!.assignedBy).toBe('ai');
    expect(byId.get(e3)!.classId).toBeNull(); // transient: logged, not learned from

    const classes = await t.json<RootCauseClassDTO[]>('GET', '/api/learning/classes', {
      headers: builder.headers,
    });
    expect(classes).toHaveLength(1);
    expect(classes[0]).toMatchObject({ dimension: 'spec', origin: 'ai', occurrences: 2 });
    // two occurrences of one cause → a repeat offence
    const offences = await t.json<OffenceDTO[]>('GET', '/api/learning/offences', {
      headers: builder.headers,
    });
    expect(offences).toHaveLength(1);
    expect(offences[0]).toMatchObject({ classId: classes[0]!.classId, state: 'detected', occurrences: 2 });

    // the same symptom again reuses the model's confident placement without another call
    const e4 = report(t, "Error: ENOENT: no such file or directory, open '/srv/other/config/app.json'", {
      sessionId: 'ses_a',
    });
    await t.drain();
    await t.rt.runJob('learning.ai');
    expect(t.llm.calls.filter((c) => c.purpose === 'learning.classify').length).toBe(3);
    expect((await errors(t, builder.headers)).find((e) => e.errorId === e4)!.classId).toBe(
      classes[0]!.classId,
    );

    // a declined signature is not re-asked until the class set changes
    await t.rt.runJob('learning.ai');
    expect(t.llm.calls.filter((c) => c.purpose === 'learning.classify').length).toBe(3);
    await t.close();
  });

  it('rule: a signature a human placed goes to the same class, and earlier machine guesses follow the human', async () => {
    const t = await learningRuntime();
    t.llm.on('learning.classify', classifier);
    const builder = t.user('builder');
    const first = report(
      t,
      "TypeError: Cannot read properties of undefined (reading 'tenantId') at handler.ts:41",
    );
    await t.rt.runJob('learning.ai'); // AI files it under a new (wrong) class
    expect((await errors(t, builder.headers))[0]!.assignedBy).toBe('ai');

    const second = report(
      t,
      "TypeError: Cannot read properties of undefined (reading 'orgId') at handler.ts:97",
    );
    await t.drain();
    const human = await t.json<{ classId: string; className: string; assignedBy: string }>(
      'POST',
      `/api/learning/errors/${second}/root-cause`,
      {
        headers: builder.headers,
        body: { newClass: { name: 'Tenant context missing from request pipeline', dimension: 'codebase' } },
      },
    );
    expect(human).toMatchObject({
      assignedBy: 'human',
      className: 'Tenant context missing from request pipeline',
    });
    await t.drain();
    // propagation: the earlier AI-assigned occurrence with the same signature follows the human decision
    const firstNow = (await errors(t, builder.headers)).find((e) => e.errorId === first)!;
    expect(firstNow).toMatchObject({ classId: human.classId, assignedBy: 'rule' });

    // a new occurrence of the same template is assigned by rule immediately — no model call needed
    const callsBefore = t.llm.calls.length;
    const third = report(
      t,
      "TypeError: Cannot read properties of undefined (reading 'userId') at handler.ts:12",
    );
    await t.drain();
    const thirdNow = (await errors(t, builder.headers)).find((e) => e.errorId === third)!;
    expect(thirdNow).toMatchObject({ classId: human.classId, assignedBy: 'rule', confidence: 1 });
    expect(t.llm.calls.length).toBe(callsBefore);
    await t.close();
  });

  it('human assignment validates input and permissions', async () => {
    const t = await learningRuntime();
    const builder = t.user('builder');
    const requester = t.user('requester');
    const id = report(t, 'boom');
    const classId = await createClass(t, builder.headers, 'Ambiguous acceptance criteria', 'spec');
    expect(
      (
        await t.request('POST', `/api/learning/errors/${id}/root-cause`, {
          headers: requester.headers,
          body: { classId },
        })
      ).status,
    ).toBe(403);
    expect((await t.request('GET', '/api/learning/errors', { headers: requester.headers })).status).toBe(403);
    expect(
      (
        await t.request('POST', `/api/learning/errors/${id}/root-cause`, {
          headers: builder.headers,
          body: { classId: 'rcc_missing' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.request('POST', '/api/learning/errors/err_missing/root-cause', {
          headers: builder.headers,
          body: { classId },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.request('POST', `/api/learning/errors/${id}/root-cause`, {
          headers: builder.headers,
          body: { newClass: { name: 'x', dimension: 'blame' } },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await t.request('POST', '/api/learning/classes', {
          headers: builder.headers,
          body: { name: 'No dimension' },
        })
      ).status,
    ).toBe(422);
    await assignTo(t, builder.headers, id, classId);
    expect((await errors(t, builder.headers, `?classId=${classId}`)).map((e) => e.errorId)).toEqual([id]);
    await t.close();
  });
});
