import { describe, expect, it } from 'vitest';
import type { JsonValue, LessonDTO, OffenceDTO } from '@aoc/contracts';
import type { TestRuntime, TestUser } from '@aoc/kernel';
import { lessonPayoff } from '../src';
import {
  addSession,
  assignTo,
  createClass,
  DAY,
  endSession,
  fileChange,
  learning,
  learningRuntime,
  MIN,
  report,
  SYS,
  usage,
} from './helpers';

interface LessonBody {
  classId?: string;
  scopeType: 'process_type' | 'code_area';
  scopeValue: string;
  rule?: string;
  fix?: string;
  rationale?: string;
}

async function propose(t: TestRuntime, by: TestUser, body: LessonBody): Promise<LessonDTO> {
  return t.json<LessonDTO>('POST', '/api/learning/lessons', {
    headers: by.headers,
    body: {
      rule: `Rule for ${body.scopeValue}`,
      fix: `Fix for ${body.scopeValue}`,
      rationale: 'Recurred in this scope',
      ...body,
    },
    expect: 201,
  });
}

async function bound(t: TestRuntime, by: TestUser, approver: TestUser, body: LessonBody): Promise<string> {
  const l = await propose(t, by, body);
  await t.decisions!.resolve(l.decisionId, { optionId: 'bind' }, approver.user);
  await t.drain();
  return l.lessonId;
}

const lessonOf = async (t: TestRuntime, h: Record<string, string>, id: string) =>
  (await t.json<LessonDTO[]>('GET', '/api/learning/lessons', { headers: h })).find((l) => l.lessonId === id)!;

describe('lessons registry', () => {
  it('binds only through a human lesson_binding decision by an approver; rejection rejects', async () => {
    const t = await learningRuntime();
    const builder = t.user('builder');
    const approver = t.user('approver');
    const classId = await createClass(t, builder.headers, 'Migration order not specified', 'spec');
    const l = await propose(t, builder, {
      classId,
      scopeType: 'process_type',
      scopeValue: 'bug-fix',
      rule: 'Check migration order before editing schema files',
      fix: 'Run pnpm db:check-order',
    });
    expect(l).toMatchObject({
      status: 'proposed',
      origin: 'human',
      classId,
      className: 'Migration order not specified',
      boundAt: null,
      payoff: null,
    });
    const card = t.decisions!.get(l.decisionId)!;
    expect(card).toMatchObject({
      kind: 'lesson_binding',
      status: 'open',
      requiredRole: 'approver',
      subjectType: 'lesson',
      subjectId: l.lessonId,
    });
    expect(card.options.map((o) => o.id)).toEqual(['bind', 'reject']);
    expect(learning(t).lessonsForScope({ processType: 'bug-fix' })).toEqual([]); // not binding until a human decides

    await expect(t.decisions!.resolve(l.decisionId, { optionId: 'bind' }, builder.user)).rejects.toThrow(
      /separation_of_duties|role/,
    );
    await t.decisions!.resolve(l.decisionId, { optionId: 'bind' }, approver.user);
    await t.drain();
    expect((await lessonOf(t, builder.headers, l.lessonId)).status).toBe('bound');
    expect(learning(t).lessonsForScope({ processType: 'bug-fix' })).toEqual([
      {
        lessonId: l.lessonId,
        scopeType: 'process_type',
        scopeValue: 'bug-fix',
        rule: 'Check migration order before editing schema files',
        fix: 'Run pnpm db:check-order',
      },
    ]);
    expect(t.rt.store.list({ types: ['lesson.bound'] })).toHaveLength(1);

    const other = await propose(t, builder, { scopeType: 'code_area', scopeValue: 'packages/web' });
    await t.decisions!.resolve(other.decisionId, { optionId: 'reject' }, approver.user);
    await t.drain();
    expect((await lessonOf(t, builder.headers, other.lessonId)).status).toBe('rejected');
    expect(learning(t).lessonsForScope({ processType: 'x', codeAreas: ['packages/web'] })).toEqual([]);

    // A binding card that expires unanswered never binds (G-33).
    const lapsed = await propose(t, builder, { scopeType: 'code_area', scopeValue: 'packages/cli' });
    t.rt.store.append({
      type: 'decision.expired',
      actor: { kind: 'system', id: 'decisions' },
      scope: { decisionId: lapsed.decisionId },
      meta: { decisionId: lapsed.decisionId, ageMs: 7 * DAY },
      source: 'system',
    });
    await t.drain();
    expect((await lessonOf(t, builder.headers, lapsed.lessonId)).status).toBe('rejected');
    await t.close();
  });

  it('rejects global or invalid scopes and checks permissions', async () => {
    const t = await learningRuntime();
    const builder = t.user('builder');
    const requester = t.user('requester');
    const post = (body: Record<string, unknown>, headers = builder.headers) =>
      t.request('POST', '/api/learning/lessons', {
        headers,
        body: { rule: 'Do the thing', fix: 'Like this', rationale: 'Because', ...body },
      });
    expect((await post({ scopeType: 'code_area', scopeValue: '.' })).status).toBe(422);
    expect((await post({ scopeType: 'code_area', scopeValue: '/' })).status).toBe(422);
    expect((await post({ scopeType: 'code_area', scopeValue: '/home/alice/repo/src' })).status).toBe(422);
    expect((await post({ scopeType: 'process_type', scopeValue: 'every type!' })).status).toBe(422);
    expect((await post({ scopeType: 'global', scopeValue: 'all' })).status).toBe(422);
    expect(
      (await post({ scopeType: 'process_type', scopeValue: 'bug-fix', classId: 'rcc_nope' })).status,
    ).toBe(404);
    expect((await post({ scopeType: 'process_type', scopeValue: 'bug-fix' }, requester.headers)).status).toBe(
      403,
    );
    await t.close();
  });

  it('scope filtering: the run’s process type and overlapping code areas only', async () => {
    const t = await learningRuntime();
    const builder = t.user('builder');
    const approver = t.user('approver');
    const bugFix = await bound(t, builder, approver, { scopeType: 'process_type', scopeValue: 'bug-fix' });
    const docs = await bound(t, builder, approver, { scopeType: 'process_type', scopeValue: 'docs' });
    const web = await bound(t, builder, approver, { scopeType: 'code_area', scopeValue: 'packages/web' });
    const kernel = await bound(t, builder, approver, {
      scopeType: 'code_area',
      scopeValue: 'packages/kernel',
    });
    await propose(t, builder, { scopeType: 'process_type', scopeValue: 'bug-fix' }); // proposed, not bound
    const ids = (s: { processType: string; codeAreas?: string[] }) =>
      learning(t)
        .lessonsForScope(s)
        .map((l) => l.lessonId)
        .sort();

    expect(ids({ processType: 'bug-fix', codeAreas: ['packages/web/src/pages'] })).toEqual(
      [bugFix, web].sort(),
    );
    expect(ids({ processType: 'docs' })).toEqual([docs]);
    expect(ids({ processType: 'feature-build', codeAreas: ['/', '.', '', '/home/alice/repo'] })).toEqual([]); // nothing global
    expect(ids({ processType: 'feature-build', codeAreas: ['packages'] })).toEqual([web, kernel].sort());

    await t.json('POST', `/api/learning/lessons/${bugFix}/retire`, { headers: builder.headers });
    expect(ids({ processType: 'bug-fix' })).toEqual([]);
    expect(
      (await t.request('POST', `/api/learning/lessons/${bugFix}/retire`, { headers: builder.headers }))
        .status,
    ).toBe(409);
    await t.close();
  });

  it('retires a lesson after N consecutive applied-but-unused runs; "used" = the run exercised its scope', async () => {
    const t = await learningRuntime({ config: { learning: { retireAfterUnusedRuns: 3 } } });
    const builder = t.user('builder');
    const approver = t.user('approver');
    const web = await bound(t, builder, approver, { scopeType: 'code_area', scopeValue: 'packages/web' });
    const bugFix = await bound(t, builder, approver, { scopeType: 'process_type', scopeValue: 'bug-fix' });
    const run = (id: string, touched?: string, end = true) => {
      addSession(t, id, 'bug-fix', 'claude-sonnet-5-5');
      learning(t).recordLessonsApplied([web, bugFix, 'les_unknown'], id, SYS);
      if (touched) fileChange(t, id, touched);
      if (end) endSession(t, id);
    };
    run('ses_1', '/work/repo/packages/web/src/App.tsx'); // used
    run('ses_2', '/work/repo/packages/kernel/src/store.ts'); // file change elsewhere: unused
    run('ses_3'); // unused
    learning(t).recordLessonsApplied([web], 'ses_1', SYS); // re-injection in the same run is one application
    expect(t.rt.store.list({ types: ['lesson.applied'] })).toHaveLength(6);

    await t.rt.runJob('learning.retire-lessons');
    let l = await lessonOf(t, builder.headers, web);
    expect(l.status).toBe('bound');
    expect(l.usage).toEqual({
      appliedRuns: 3,
      usedRuns: 1,
      unusedRuns: 2,
      pendingRuns: 0,
      unusedStreak: 2,
      retireAfterUnusedRuns: 3,
    });

    run('ses_4', undefined, false); // still running: pending, not yet unused
    await t.rt.runJob('learning.retire-lessons');
    expect((await lessonOf(t, builder.headers, web)).status).toBe('bound');

    run('ses_5'); // third settled unused run in a row
    await t.rt.runJob('learning.retire-lessons');
    l = await lessonOf(t, builder.headers, web);
    expect(l).toMatchObject({ status: 'retired', retireReason: 'unused' });
    expect(l.usage.pendingRuns).toBe(1);
    expect(t.rt.store.list({ types: ['lesson.retired'] }).map((e) => e.meta)).toEqual([
      { lessonId: web, reason: 'unused', runsUnused: 3 },
    ]);
    expect(learning(t).lessonsForScope({ processType: 'x', codeAreas: ['packages/web'] })).toEqual([]);
    // the process-type lesson was exercised by every bug-fix run
    expect((await lessonOf(t, builder.headers, bugFix)).usage).toMatchObject({
      usedRuns: 5,
      unusedStreak: 0,
    });
    expect((await lessonOf(t, builder.headers, bugFix)).status).toBe('bound');

    // a run that never reports an end settles after runSettleHours (default 24)
    t.clock.advance(DAY + MIN);
    expect((await lessonOf(t, builder.headers, web)).usage.pendingRuns).toBe(0);
    await t.close();
  });

  it('payoff = baseline rate per exposure × exposures after − recurrences after; savings = prevented × average cost', async () => {
    expect(
      lessonPayoff({
        exposuresBefore: 10,
        occurrencesBefore: 2,
        exposuresAfter: 5,
        recurrencesAfter: 3,
        avgCostUsd: 1,
        avgCostMs: 10,
        avgTokens: 100,
      }),
    ).toEqual({
      baselineRatePerExposure: 0.2,
      expectedRecurrences: 1,
      repeatsPrevented: -2, // the lesson is not working: prune it
      usdSaved: -2,
      msSaved: -20,
      tokensSaved: -200,
    });

    const t = await learningRuntime();
    const builder = t.user('builder');
    const approver = t.user('approver');
    const classId = await createClass(
      t,
      builder.headers,
      'Seed data assumed by integration tests',
      'context',
    );
    // before binding: 4 bug-fix runs, 2 occurrences costing $1 and $3 (5 minutes each)
    for (let i = 0; i < 4; i++) addSession(t, `ses_b${i}`, 'bug-fix', 'claude-opus-5-5');
    addSession(t, 'ses_docs', 'docs', 'claude-haiku-5-5'); // another process type: not an exposure
    const e1 = report(t, 'relation "users" is empty', { sessionId: 'ses_b0' });
    usage(t, 'ses_b0', 1000, 5);
    await assignTo(t, builder.headers, e1, classId);
    const e2 = report(t, 'fixture account missing for login test', { sessionId: 'ses_b1' });
    usage(t, 'ses_b1', 3000, 5);
    await assignTo(t, builder.headers, e2, classId);

    t.clock.advance(DAY);
    const lessonId = await bound(t, builder, approver, {
      classId,
      scopeType: 'process_type',
      scopeValue: 'bug-fix',
    });
    t.clock.advance(MIN);
    // after binding: 6 exposed runs, 1 recurrence
    for (let i = 0; i < 6; i++) addSession(t, `ses_a${i}`, 'bug-fix', 'claude-opus-5-5');
    const e3 = report(t, 'seed rows missing for tenant test', { sessionId: 'ses_a0' });
    await assignTo(t, builder.headers, e3, classId);

    expect((await lessonOf(t, builder.headers, lessonId)).payoff).toEqual({
      measurable: true,
      exposuresBefore: 4,
      occurrencesBefore: 2,
      baselineRatePerExposure: 0.5,
      exposuresAfter: 6,
      recurrencesAfter: 1,
      expectedRecurrences: 3,
      repeatsPrevented: 2,
      avgOccurrenceCostUsd: 2,
      avgOccurrenceMs: 5 * MIN,
      avgOccurrenceTokens: 2000,
      usdSaved: 4,
      msSaved: 10 * MIN,
      tokensSaved: 4000,
    });
    await t.close();
  });

  it('auto-proposes a scoped lesson (learning.distill) when an offence is root-caused with a fix — binding stays human', async () => {
    const t = await learningRuntime();
    const builder = t.user('builder');
    const approver = t.user('approver');
    const classId = await createClass(
      t,
      builder.headers,
      'Seed data assumed by integration tests',
      'context',
    );
    addSession(t, 'ses_1', 'bug-fix', 'claude-opus-5-5');
    addSession(t, 'ses_2', 'bug-fix', 'claude-opus-5-5');
    await assignTo(
      t,
      builder.headers,
      report(t, 'relation "users" is empty', { sessionId: 'ses_1' }),
      classId,
    );
    await assignTo(t, builder.headers, report(t, 'fixture account missing', { sessionId: 'ses_2' }), classId);
    const [off] = await t.json<OffenceDTO[]>('GET', '/api/learning/offences', { headers: builder.headers });
    t.llm.on('learning.distill', (req): JsonValue =>
      req.prompt.includes('Candidate process types: bug-fix (3)')
        ? {
            skip: false,
            scopeType: 'process_type',
            scopeValue: 'bug-fix',
            rule: 'Seed the test database before integration tests',
            fix: 'pnpm db:seed:test',
            rationale: 'Two bug-fix runs failed on missing seed data',
          }
        : { skip: true },
    );

    // root-caused without a stated fix: nothing to distill
    await t.json('POST', `/api/learning/offences/${off!.offenceId}/transition`, {
      headers: builder.headers,
      body: { to: 'root_caused', note: 'tests assume seed data' },
    });
    await t.rt.runJob('learning.ai');
    expect(t.llm.calls.filter((c) => c.purpose === 'learning.distill')).toHaveLength(0);

    // reopened and root-caused again, this time with the fix
    t.clock.advance(MIN);
    await t.json('POST', `/api/learning/offences/${off!.offenceId}/transition`, {
      headers: builder.headers,
      body: { to: 'fix_applied', fix: 'pnpm db:seed:test' },
    });
    await assignTo(
      t,
      builder.headers,
      report(t, 'relation "orgs" is empty', { sessionId: 'ses_1' }),
      classId,
    ); // recurrence → reopened
    await t.json('POST', `/api/learning/offences/${off!.offenceId}/transition`, {
      headers: builder.headers,
      body: { to: 'root_caused', fix: 'pnpm db:seed:test' },
    });
    await t.rt.runJob('learning.ai');
    await t.rt.runJob('learning.ai'); // idempotent: proposed once
    const distill = t.llm.calls.filter((c) => c.purpose === 'learning.distill');
    expect(distill).toHaveLength(1);
    expect(distill[0]!.model).toBe('sonnet');

    const lessons = await t.json<LessonDTO[]>('GET', '/api/learning/lessons', { headers: builder.headers });
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({
      status: 'proposed',
      origin: 'ai',
      classId,
      scopeType: 'process_type',
      scopeValue: 'bug-fix',
      rule: 'Seed the test database before integration tests',
    });
    expect(learning(t).lessonsForScope({ processType: 'bug-fix' })).toEqual([]);
    await t.decisions!.resolve(lessons[0]!.decisionId, { optionId: 'bind' }, approver.user);
    await t.drain();
    expect(
      learning(t)
        .lessonsForScope({ processType: 'bug-fix' })
        .map((l) => l.lessonId),
    ).toEqual([lessons[0]!.lessonId]);
    await t.close();
  });

  it('never distills a lesson scoped outside where the class actually recurred', async () => {
    const t = await learningRuntime();
    const builder = t.user('builder');
    const classId = await createClass(t, builder.headers, 'Release notes format unclear', 'spec');
    addSession(t, 'ses_1', 'docs', 'claude-haiku-5-5');
    await assignTo(
      t,
      builder.headers,
      report(t, 'changelog lint failed', { sessionId: 'ses_1', fix: 'use the template' }),
      classId,
    );
    await assignTo(
      t,
      builder.headers,
      report(t, 'changelog heading missing', { sessionId: 'ses_1' }),
      classId,
    );
    const [off] = await t.json<OffenceDTO[]>('GET', '/api/learning/offences', { headers: builder.headers });
    t.llm.on('learning.distill', {
      skip: false,
      scopeType: 'process_type',
      scopeValue: 'feature-build',
      rule: 'Always follow the template',
      fix: 'use it',
    });
    await t.json('POST', `/api/learning/offences/${off!.offenceId}/transition`, {
      headers: builder.headers,
      body: { to: 'root_caused' },
    });
    await t.rt.runJob('learning.ai');
    expect(t.llm.calls.filter((c) => c.purpose === 'learning.distill')).toHaveLength(1); // the occurrence's own fix counts
    expect(await t.json<LessonDTO[]>('GET', '/api/learning/lessons', { headers: builder.headers })).toEqual(
      [],
    );
    await t.close();
  });
});
