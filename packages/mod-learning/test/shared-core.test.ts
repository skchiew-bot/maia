/**
 * Lessons use "the same distillation engine as playbooks" (§11): the model call and the Approver gate of
 * both proposal paths (AI-distilled and human-proposed) run through the shared core in @aoc/distill.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LessonDTO, OffenceDTO } from '@aoc/contracts';
import * as core from '@aoc/distill';
import type { TestRuntime } from '@aoc/kernel';
import { AI_ACTOR, LESSON_GATE } from '../src/engine';
import { addSession, assignTo, createClass, learning, learningRuntime, report } from './helpers';

vi.mock('@aoc/distill', async (importOriginal) => {
  const real = await importOriginal<typeof import('@aoc/distill')>();
  return {
    ...real,
    distill: vi.fn(real.distill),
    proposeForApproval: vi.fn(real.proposeForApproval),
    gateVerdict: vi.fn(real.gateVerdict),
  };
});

let t: TestRuntime;
afterEach(async () => {
  vi.clearAllMocks();
  await t?.close();
});

const lessons = (headers: Record<string, string>) =>
  t.json<LessonDTO[]>('GET', '/api/learning/lessons', { headers });

describe('lesson proposals go through the shared distillation core', () => {
  it('AI path: the distillation call and the Approver gate are the shared ones', async () => {
    t = await learningRuntime();
    const builder = t.user('builder');
    const classId = await createClass(
      t,
      builder.headers,
      'Seed data assumed by integration tests',
      'context',
    );
    addSession(t, 'ses_1', 'bug-fix', 'claude-opus-5-5');
    addSession(t, 'ses_2', 'bug-fix', 'claude-opus-5-5');
    for (const [sessionId, message] of [
      ['ses_1', 'relation "users" is empty'],
      ['ses_2', 'fixture account missing'],
    ] as const)
      await assignTo(
        t,
        builder.headers,
        report(t, message, { sessionId, fix: 'pnpm db:seed:test' }),
        classId,
      );
    const [off] = await t.json<OffenceDTO[]>('GET', '/api/learning/offences', { headers: builder.headers });
    await t.json('POST', `/api/learning/offences/${off!.offenceId}/transition`, {
      headers: builder.headers,
      body: { to: 'root_caused', fix: 'pnpm db:seed:test' },
    });
    t.llm.on('learning.distill', {
      skip: false,
      scopeType: 'process_type',
      scopeValue: 'bug-fix',
      rule: 'Seed the test database before integration tests',
      fix: 'pnpm db:seed:test',
    });

    await t.rt.runJob('learning.ai');

    expect(core.distill).toHaveBeenCalledTimes(1);
    const [llm, req] = vi.mocked(core.distill).mock.calls[0]!;
    expect(llm).toBe(t.llm);
    expect(req).toMatchObject({ purpose: 'learning.distill', model: 'sonnet', maxTokens: 1024 });
    expect(req.prompt).toContain('Stated fix: pnpm db:seed:test');
    expect(core.proposeForApproval).toHaveBeenCalledWith(
      expect.objectContaining({ gate: LESSON_GATE, actor: AI_ACTOR }),
    );
    expect(await lessons(builder.headers)).toEqual([
      expect.objectContaining({ origin: 'ai', status: 'proposed', scopeValue: 'bug-fix' }),
    ]);
  });

  it('human path: a proposed lesson raises the same Approver gate', async () => {
    t = await learningRuntime();
    const builder = t.user('builder');
    const l = await t.json<LessonDTO>('POST', '/api/learning/lessons', {
      headers: builder.headers,
      body: {
        scopeType: 'code_area',
        scopeValue: 'packages/web',
        rule: 'Escape all text',
        fix: 'Use esc()',
        rationale: 'Raw text reached the page twice',
      },
      expect: 201,
    });
    expect(core.distill).not.toHaveBeenCalled();
    expect(core.proposeForApproval).toHaveBeenCalledWith(
      expect.objectContaining({ gate: LESSON_GATE, actor: { kind: 'human', id: builder.user.id } }),
    );
    expect(t.decisions!.get(l.decisionId)).toMatchObject({
      kind: 'lesson_binding',
      requiredRole: 'approver',
    });
  });

  it('only a person binds a lesson: a policy resolution that picks "bind" rejects it, as for playbooks', async () => {
    t = await learningRuntime();
    const builder = t.user('builder');
    const approver = t.user('approver');
    const propose = (scopeValue: string) =>
      t.json<LessonDTO>('POST', '/api/learning/lessons', {
        headers: builder.headers,
        body: {
          scopeType: 'process_type',
          scopeValue,
          rule: `Rule ${scopeValue}`,
          fix: `Fix ${scopeValue}`,
          rationale: 'Recurred in this scope',
        },
        expect: 201,
      });

    const byPolicy = await propose('bug-fix');
    t.decisions!.resolveByPolicy(byPolicy.decisionId, 'bind', { kind: 'system', id: 'some-policy' });
    const byPerson = await propose('docs');
    await t.decisions!.resolve(byPerson.decisionId, { optionId: 'bind' }, approver.user);
    await t.drain();

    const status = Object.fromEntries((await lessons(builder.headers)).map((l) => [l.scopeValue, l.status]));
    expect(status).toEqual({ 'bug-fix': 'rejected', docs: 'bound' });
    expect(core.gateVerdict).toHaveBeenCalled();
    expect(learning(t).lessonsForScope({ processType: 'bug-fix' })).toEqual([]);
    expect(
      learning(t)
        .lessonsForScope({ processType: 'docs' })
        .map((l) => l.lessonId),
    ).toEqual([byPerson.lessonId]);
  });
});
