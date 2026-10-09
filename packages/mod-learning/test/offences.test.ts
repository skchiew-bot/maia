import { describe, expect, it } from 'vitest';
import type { ErrorOccurrenceDTO, OffenceDTO, RecurrenceTrendDTO } from '@aoc/contracts';
import {
  addSession,
  assignTo,
  createClass,
  DAY,
  errors,
  learningRuntime,
  MIN,
  report,
  usage,
} from './helpers';

describe('repeat-offence lifecycle', () => {
  it('detected → root_caused → fix_applied → verified_closed after the window (fake clock) → reopened on recurrence', async () => {
    const t = await learningRuntime();
    const builder = t.user('builder');
    const h = builder.headers;
    const classId = await createClass(t, h, 'Migration order not specified', 'spec');
    const e1 = report(t, 'relation "invoices" does not exist');
    await assignTo(t, h, e1, classId);
    expect(await t.json<OffenceDTO[]>('GET', '/api/learning/offences', { headers: h })).toHaveLength(0); // one occurrence is not a repeat

    const e2 = report(t, 'column invoices.tenant_id does not exist'); // different symptom, same cause
    await assignTo(t, h, e2, classId);
    let [off] = await t.json<OffenceDTO[]>('GET', '/api/learning/offences', { headers: h });
    expect(off).toMatchObject({ classId, state: 'detected', occurrences: 2, reopenCount: 0 });
    const url = `/api/learning/offences/${off!.offenceId}/transition`;

    expect((await t.request('POST', url, { headers: h, body: { to: 'fix_applied' } })).status).toBe(409);
    off = await t.json<OffenceDTO>('POST', url, {
      headers: h,
      body: {
        to: 'root_caused',
        note: 'Spec never states migration order',
        fix: 'Declare migration order in the plan',
      },
    });
    expect(off).toMatchObject({ state: 'root_caused', fix: 'Declare migration order in the plan' });
    off = await t.json<OffenceDTO>('POST', url, {
      headers: h,
      body: { to: 'fix_applied', note: 'Spec template updated' },
    });
    expect(off.state).toBe('fix_applied');
    expect(off.verifyDueAt).toBe(new Date(t.clock.now() + 14 * DAY).toISOString());
    expect((await t.request('POST', url, { headers: h, body: { to: 'verified_closed' } })).status).toBe(409); // only the job closes

    t.clock.advance(13 * DAY);
    await t.rt.runJob('learning.verify-offences');
    [off] = await t.json<OffenceDTO[]>('GET', '/api/learning/offences', { headers: h });
    expect(off!.state).toBe('fix_applied');
    t.clock.advance(1 * DAY + MIN);
    await t.rt.runJob('learning.verify-offences');
    [off] = await t.json<OffenceDTO[]>('GET', '/api/learning/offences', { headers: h });
    expect(off).toMatchObject({ state: 'verified_closed', occurrencesSinceFix: 0 });
    expect(off!.verifiedClosedAt).toBeTruthy();

    // recurrence (same template as e1 → rule-assigned to the class) reopens the closed offence
    report(t, 'relation "payments" does not exist');
    await t.drain();
    [off] = await t.json<OffenceDTO[]>('GET', '/api/learning/offences', { headers: h });
    expect(off).toMatchObject({ state: 'reopened', reopenCount: 1, occurrences: 3, occurrencesSinceFix: 1 });
    expect(off!.history.map((x) => x.to)).toEqual([
      'detected',
      'root_caused',
      'fix_applied',
      'verified_closed',
      'reopened',
    ]);
    expect(off!.history[1]!.note).toBe('Spec never states migration order');

    // second cycle: a recurrence inside the verification window reopens it straight from fix_applied
    off = await t.json<OffenceDTO>('POST', url, {
      headers: h,
      body: { to: 'fix_applied', fix: 'Add a migration-order check to CI' },
    });
    expect(off.state).toBe('fix_applied');
    t.clock.advance(3 * DAY);
    report(t, 'relation "ledgers" does not exist');
    await t.drain();
    [off] = await t.json<OffenceDTO[]>('GET', '/api/learning/offences', { headers: h });
    expect(off).toMatchObject({ state: 'reopened', reopenCount: 2 });
    expect(t.rt.store.verifyChain().ok).toBe(true);
    await t.close();
  });

  it('prioritises by cost of recurrence, not by count', async () => {
    const t = await learningRuntime();
    const h = t.user('builder').headers;
    const cheap = await createClass(t, h, 'Lint config drift', 'tooling');
    const costly = await createClass(t, h, 'Auth flow undocumented', 'spec');
    // 5 cheap occurrences: $0.10 each of follow-up usage
    for (let i = 0; i < 5; i++) {
      addSession(t, `ses_c${i}`, 'feature-build', 'claude-opus-5-5');
      const id = report(t, `eslint: unknown rule ${i}`, { sessionId: `ses_c${i}` });
      usage(t, `ses_c${i}`, 100, 5);
      await assignTo(t, h, id, cheap);
    }
    // 2 costly occurrences: $2.00 each
    for (let i = 0; i < 2; i++) {
      addSession(t, `ses_x${i}`, 'feature-build', 'claude-opus-5-5');
      const id = report(t, `401 from /oauth/token attempt ${i}`, { sessionId: `ses_x${i}` });
      usage(t, `ses_x${i}`, 2000, 10);
      await assignTo(t, h, id, costly);
    }
    const offences = await t.json<OffenceDTO[]>('GET', '/api/learning/offences', { headers: h });
    expect(offences.map((o) => [o.classId, o.occurrences, o.costOfRecurrenceUsd])).toEqual([
      [costly, 2, 4],
      [cheap, 5, 0.5],
    ]);
    expect(offences[0]!.costMs).toBe(2 * 10 * MIN);
    expect(offences[0]!.costTokens).toBe(4000);
    await t.close();
  });

  it('counts only usage inside the 30-minute window, closed early at the session’s next error', async () => {
    const t = await learningRuntime();
    const h = t.user('builder').headers;
    addSession(t, 'ses_1', 'feature-build', 'claude-opus-5-5');
    const a = report(t, 'first failure', { sessionId: 'ses_1' });
    usage(t, 'ses_1', 1000, 5); // → a
    t.clock.advance(10 * MIN);
    const b = report(t, 'second failure', { sessionId: 'ses_1' });
    usage(t, 'ses_1', 3000, 5); // → b only (a's window closed when b happened)
    usage(t, 'ses_1', 7000, 40); // outside b's 30-minute window
    const byId = new Map((await errors(t, h)).map((e: ErrorOccurrenceDTO) => [e.errorId, e]));
    expect(byId.get(a)!.cost).toMatchObject({
      usd: 1,
      tokens: 1000,
      ms: 5 * MIN,
      basis: 'metering',
      provisional: false,
    });
    expect(byId.get(b)!.cost).toMatchObject({ usd: 3, tokens: 3000, ms: 5 * MIN, provisional: true });
    t.clock.advance(31 * MIN);
    expect((await errors(t, h)).find((e) => e.errorId === b)!.cost.provisional).toBe(false);
    await t.close();
  });

  it('falls back to a per-tier token estimate when metering is unavailable', async () => {
    const t = await learningRuntime({ metering: false });
    const h = t.user('builder').headers;
    addSession(t, 'ses_h', 'docs', 'claude-haiku-5-5');
    report(t, 'docs build failed', { sessionId: 'ses_h' });
    usage(t, 'ses_h', 1_000_000, 5, 'claude-haiku-5-5');
    const [e] = await errors(t, h);
    expect(e!.cost).toMatchObject({ basis: 'estimate', usd: 0.1 }); // haiku input list price $0.10 / MTok
    await t.close();
  });

  it('UAT failures feed in with priority: high, weighted in the ranking and classified first', async () => {
    const t = await learningRuntime({ options: { classifyBatch: 1 } });
    const h = t.user('builder').headers;
    const requester = t.user('requester');
    addSession(t, 'ses_build', 'bug-fix', 'claude-sonnet-5-5');
    t.rt.store.append({
      type: 'ticket.build_started',
      actor: { kind: 'system', id: 'intake' },
      scope: { ticketId: 'tkt_1' },
      meta: { ticketId: 'tkt_1', sessionId: 'ses_build', changeId: null },
      source: 'intake',
    });
    addSession(t, 'ses_n0', 'bug-fix', 'claude-sonnet-5-5');
    const normal = report(t, 'checkout total off by one cent', { sessionId: 'ses_n0' }); // classified later despite being older
    usage(t, 'ses_n0', 2000, 5);
    const uat = async (comment: string) => {
      t.clock.advance(40 * MIN);
      t.rt.store.append({
        type: 'ticket.uat_result',
        actor: { kind: 'human', id: requester.user.id },
        scope: { ticketId: 'tkt_1' },
        meta: { ticketId: 'tkt_1', requesterId: requester.user.id, verdict: 'fail' },
        payload: { comment },
        source: 'intake',
      });
      await t.drain();
      usage(t, 'ses_build', 1000, 5); // rework after the rejection: $1
    };
    await uat('Login button does nothing on Safari');
    t.rt.store.append({
      type: 'ticket.uat_result',
      actor: { kind: 'human', id: requester.user.id },
      scope: { ticketId: 'tkt_1' },
      meta: { ticketId: 'tkt_1', requesterId: requester.user.id, verdict: 'pass' },
      payload: {},
      source: 'intake',
    });
    await t.drain();
    const uatErrors = (await errors(t, h)).filter((e) => e.source === 'uat');
    expect(uatErrors).toHaveLength(1); // a pass is not an error
    expect(uatErrors[0]).toMatchObject({
      priority: 'high',
      processType: 'bug-fix',
      modelTier: 'sonnet',
      message: 'Login button does nothing on Safari',
    });
    expect(uatErrors[0]!.cost).toMatchObject({ usd: 1, weightedUsd: 3 });

    // classification takes the UAT failure first even though the normal error is older
    t.llm.on('learning.classify', { classId: null, newClass: null, confidence: 0.1 });
    await t.rt.runJob('learning.ai');
    expect(t.llm.calls[0]!.prompt).toContain('Login button does nothing on Safari');
    expect(t.llm.calls[0]!.prompt).not.toContain('checkout total');

    // ranking: 2 UAT failures at $1 raw outweigh 2 normal errors at $2 raw (3× multiplier)
    await uat('Still broken on Safari after the fix');
    const uatClass = await createClass(t, h, 'Browser matrix missing from acceptance tests', 'guardrail');
    const otherClass = await createClass(t, h, 'Rounding rule ambiguous', 'spec');
    for (const e of (await errors(t, h)).filter((x) => x.source === 'uat'))
      await assignTo(t, h, e.errorId, uatClass);
    addSession(t, 'ses_n', 'bug-fix', 'claude-sonnet-5-5');
    t.clock.advance(MIN);
    const second = report(t, 'checkout total off by two cents', { sessionId: 'ses_n' });
    usage(t, 'ses_n', 2000, 5);
    await assignTo(t, h, normal, otherClass);
    await assignTo(t, h, second, otherClass);
    const offences = await t.json<OffenceDTO[]>('GET', '/api/learning/offences', { headers: h });
    expect(offences.map((o) => [o.classId, o.highPriorityOccurrences, o.costOfRecurrenceUsd])).toEqual([
      [uatClass, 2, 6],
      [otherClass, 0, 4],
    ]);
    await t.close();
  });

  it('recurrence trend: weekly occurrence counts per repeat class, weeks starting Monday in local time', async () => {
    const t = await learningRuntime();
    const h = t.user('builder').headers;
    const env = await createClass(t, h, 'Env var undocumented', 'environment');
    const once = await createClass(t, h, 'One-off', 'unknown');
    t.clock.set('2026-09-29T02:00:00.000Z');
    await assignTo(t, h, report(t, 'API_URL missing'), env);
    t.clock.set('2026-09-30T02:00:00.000Z');
    await assignTo(t, h, report(t, 'SMTP_HOST missing'), env);
    t.clock.set('2026-10-04T16:30:00.000Z'); // Sunday in UTC, but Monday 00:30 in Kuala Lumpur → the week of Oct 5
    await assignTo(t, h, report(t, 'QUEUE_URL missing'), env);
    await assignTo(t, h, report(t, 'one-off failure'), once); // a single occurrence is not a recurrence
    report(t, 'unclassified noise');
    t.clock.set('2026-10-07T02:00:00.000Z');
    const trend = await t.json<RecurrenceTrendDTO>('GET', '/api/learning/trends?weeks=3', { headers: h });
    expect(trend.weeks).toEqual(['2026-09-21', '2026-09-28', '2026-10-05']);
    expect(trend.classes).toEqual([
      {
        classId: env,
        name: 'Env var undocumented',
        dimension: 'environment',
        counts: [0, 2, 1],
        total: 3,
        offenceState: 'detected',
      },
    ]);
    expect(trend.unclassified).toEqual([0, 0, 1]);
    expect(
      (await t.json<RecurrenceTrendDTO>('GET', '/api/learning/trends', { headers: h })).weeks,
    ).toHaveLength(12);
    expect((await t.request('GET', '/api/learning/trends?weeks=0', { headers: h })).status).toBe(422);
    expect((await t.request('GET', '/api/learning/trends?weeks=many', { headers: h })).status).toBe(422);
    await t.close();
  });
});
