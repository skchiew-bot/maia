/**
 * Intake tickets in every stage of the funnel (§7), filed through the portal API as the demo requesters and advanced by
 * intake's own flow: triage on submit, the fix-plan gate, the build after the Approver's approval, UAT ready only when
 * `uat/<ticket>` really exists, the requester's sign-off, the go-live promotion through the provenance check and the
 * passkey gate. The seeder plays only the sessions' part (the agents' tool calls, diagnoses and commits). A ticket
 * whose stage needs a process ("in triage") is left as a queued launch that aocd's startup recovery runs on claude-sim.
 */
import type { DecisionCard } from '@aoc/contracts';
import { DIAGNOSES, TICKETS, fixFor, type TicketKey } from './content';
import { receiptPhoto, screenshot } from './png';
import { planFor, type Plan } from './plans';
import { between } from './rng';
import { READ_ONLY_TOOLS, type QueuedLaunch, type SimSession } from './sessions';
import { workday } from './time';
import { DAY, HOUR, MINUTE, agent, sys, type ProjectInfo, type SeedWorld } from './world';

export interface TicketRef {
  ticketId: string;
  key: string;
  projectId: string;
}

/** What the "now" section needs from the ticket whose build waits on a decision. */
export interface WaitingBuild {
  session: SimSession;
  decision: DecisionCard;
  /** When its turn ended on the decision. */
  waitingSince: number;
  /** The context the conversation had then (claude-sim resumes it with the same). */
  contextTokens: number;
}

export interface TicketOutput {
  tickets: TicketRef[];
  waiting: WaitingBuild | null;
}

const ATTACHMENT: Partial<Record<TicketKey, { name: string; bytes: () => Buffer }>> = {
  receipts: { name: 'receipt.png', bytes: receiptPhoto },
  duplicate: { name: 'confirmation-email.png', bytes: screenshot },
  'blank-login': { name: 'white-screen.png', bytes: screenshot },
  'wrong-name': { name: 'panel.png', bytes: screenshot },
};

/** Tests a triage agent names as evidence, by project (files of the seeded repositories). */
const TRIAGE_EVIDENCE = {
  claims: 'test/claims/submit.test.ts > submits a claim',
  cx: 'test/desktop/whisper.test.ts > rankSuggestions ranks suggestions by intent confidence',
};

export function scheduleTickets(w: SeedWorld): TicketOutput {
  const out: TicketOutput = { tickets: [], waiting: null };
  const { claims, cx } = w.projects;
  const now = w.now;
  const projectOf = (key: TicketKey): ProjectInfo => (TICKETS[key].project === 'claims' ? claims : cx);
  const decisions = () => w.rt.services.get('decisions');

  async function file(key: TicketKey, at: number): Promise<string> {
    const t = TICKETS[key];
    w.at(at);
    const form = new FormData();
    form.set('title', t.title);
    form.set('description', t.description);
    if (t.comment) form.set('comment', t.comment);
    form.set('severity', t.severity);
    form.set('projectId', projectOf(key).id);
    const attachment = ATTACHMENT[key];
    if (attachment) form.append('files', new File([new Uint8Array(attachment.bytes())], attachment.name, { type: 'image/png' }));
    const r = await w.api<{ ticketId: string }>('POST', '/portal/api/intakes', w.people[t.by].token, form);
    if (r.status !== 201 || !r.data?.ticketId) throw new Error(`intake refused ticket ${key}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    out.tickets.push({ ticketId: r.data.ticketId, key, projectId: projectOf(key).id });
    await w.settle();
    return r.data.ticketId;
  }

  const triagePlan = (key: TicketKey, i: number): Plan => ({
    phases: [
      {
        id: 'diagnose',
        name: 'Diagnose',
        tasks: [
          { id: `tr-${key}${i + 1}-1`, title: 'Trace the reported behaviour through the code', size: 's' },
          { id: `tr-${key}${i + 1}-2`, title: 'Confirm the root cause against the tests', size: 's' },
        ],
      },
    ],
  });

  /** The two read-only triage agents intake launched run, report their diagnoses and end (the seeder plays their process). */
  async function triage(ticketId: string, key: TicketKey, at: number): Promise<void> {
    const reports = DIAGNOSES[key]!;
    const evidence = TRIAGE_EVIDENCE[TICKETS[key].project];
    const queued = w.kit.queuedFor(ticketId).filter((q) => q.type === 'bug-triage');
    let latest = at;
    for (const [i, q] of queued.entries()) {
      const d = reports[i % reports.length]!;
      w.at(at + i * 2 * MINUTE);
      const s = w.kit.begin(q.sessionId, triagePlan(key, i));
      w.kit.declare(s);
      w.kit.tools(s, between(8, 14), between(4, 9) * MINUTE, READ_ONLY_TOOLS);
      w.kit.usage(s, between(6, 12), between(60_000, 140_000));
      w.kit.done(s, `tr-${key}${i + 1}-1`, 'diagnose', 's', { kind: 'test', ref: evidence });
      w.store.append({
        type: 'ticket.diagnosis_reported',
        actor: agent(s.sessionId),
        scope: { ticketId, sessionId: s.sessionId },
        // The class is agent-written text from a session that reads untrusted ticket text: it travels in the erasable
        // body with the rest of the diagnosis, never in the clear chain.
        meta: { ticketId, sessionId: s.sessionId, confidence: d.confidence },
        payload: { rootCause: d.rootCause, fixPlan: d.fixPlan, affectedAreas: d.affectedAreas, rootCauseClass: d.rootCauseClass },
        source: 'mcp',
        bodyScope: ticketId,
      });
      w.kit.done(s, `tr-${key}${i + 1}-2`, 'diagnose', 's', { kind: 'test', ref: evidence, detail: 'The existing test never exercises the reported behaviour' });
      w.kit.end(s);
      latest = Math.max(latest, w.clock.now());
    }
    // What intake does with the reports (fix-plan card, escalation) happens after the last agent finished.
    w.at(latest);
    await w.settle();
  }

  const openCard = (ticketId: string, kind: DecisionCard['kind']): DecisionCard => {
    const card = decisions().list({ kind: [kind], status: ['open'], subjectId: ticketId })[0];
    if (!card) throw new Error(`ticket ${ticketId} has no open ${kind} decision`);
    return card;
  };

  async function approveFixPlan(ticketId: string, at: number, comment: string): Promise<void> {
    w.at(at);
    await w.kit.resolve(openCard(ticketId, 'fix_plan').id, 'approve', 'ceo', comment);
  }

  const buildLaunch = (ticketId: string): QueuedLaunch => {
    const q = w.kit.queuedFor(ticketId).find((x) => x.type === 'bug-fix');
    if (!q) throw new Error(`intake started no build for ${ticketId}`);
    return q;
  };

  /** The build intake launched after the approval: fix and regression test committed on uat/<ticket>, then it ends. */
  async function build(ticketId: string, key: TicketKey, at: number): Promise<void> {
    const project = projectOf(key);
    const steps = fixFor(key);
    const tag = `bd-${key}`;
    const plan: Plan = {
      phases: [
        {
          id: 'fix',
          name: 'Fix',
          tasks: [
            { id: `${tag}-1`, title: 'Apply the approved fix', size: 'm' },
            { id: `${tag}-2`, title: 'Regression test', size: 's' },
          ],
        },
      ],
    };
    w.at(at);
    const s = w.kit.begin(buildLaunch(ticketId).sessionId, plan);
    s.branch = `uat/${ticketId}`;
    w.kit.declare(s, w.kit.treeOf(project.repo));
    w.kit.tools(s, 9, 11 * MINUTE);
    const trailers = [`AOC-Ticket: ${ticketId}`];
    const fix = w.kit.commit(s, steps[0]!.message, steps[0]!.files, trailers);
    w.kit.usage(s, 11, 90_000);
    w.kit.done(s, `${tag}-1`, 'fix', 'm', { commit: fix, detail: 'Committed on the UAT branch' });
    w.kit.tools(s, 5, 7 * MINUTE);
    const test = w.kit.commit(s, steps[1]!.message, steps[1]!.files, trailers);
    const last = w.kit.done(s, `${tag}-2`, 'fix', 's', { commit: test });
    w.kit.phaseDone(s, 'fix', last, test);
    w.kit.end(s);
    await w.settle();
  }

  async function signOff(ticketId: string, key: TicketKey, at: number, comment: string): Promise<void> {
    w.at(at);
    await w.ok('POST', `/portal/api/tickets/${ticketId}/uat`, TICKETS[key].by, { verdict: 'pass', comment });
    await w.settle();
  }

  async function goLive(ticketId: string, at: number): Promise<void> {
    const requested = w.store.list({ types: ['ticket.golive_requested'], limit: 1000 }).find((e) => e.meta.ticketId === ticketId);
    if (!requested) throw new Error(`ticket ${ticketId} has no go-live request`);
    w.at(at);
    await w.signer.resolve(String(requested.meta.decisionId), 'approve', 'ceo', 'UAT passed and every commit traces to the approved fix plan; go live.');
  }

  // ── completed: the full path, through a real promotion ─────────────────────────────────────────────────────
  function completedFlow(key: TicketKey, o: { file: number; approve: number; build: number; signOff: number; goLive: number; plan: string; uat: string }): void {
    w.timeline.schedule(o.file, `ticket ${key}: filed, built, promoted`, async () => {
      const id = await file(key, o.file);
      await triage(id, key, o.file + 3 * MINUTE);
      await approveFixPlan(id, o.approve, o.plan);
      await build(id, key, o.build);
      await signOff(id, key, o.signOff, o.uat);
      await goLive(id, o.goLive);
    });
  }

  completedFlow('claim-total', {
    file: workday(now, 5, '09:10'),
    approve: workday(now, 5, '13:05'),
    build: workday(now, 5, '13:20'),
    signOff: workday(now, 4, '10:15'),
    goLive: workday(now, 4, '11:00'),
    plan: 'Low risk and reversible on UAT; approved.',
    uat: 'The summary shows MYR and SGD now. Thanks!',
  });
  completedFlow('cx-panel', {
    file: workday(now, 5, '10:30'),
    approve: workday(now, 5, '15:00'),
    build: workday(now, 5, '15:10'),
    signOff: workday(now, 4, '09:40'),
    goLive: workday(now, 4, '10:30'),
    plan: 'Approved: layout only, no data involved.',
    uat: 'Fits my screen now.',
  });

  // ── closed ─────────────────────────────────────────────────────────────────────────────────────────────────
  w.timeline.schedule(workday(now, 4, '09:15'), 'ticket cannot-repro: closed from the low-confidence card', async () => {
    const id = await file('cannot-repro', workday(now, 4, '09:15'));
    await triage(id, 'cannot-repro', workday(now, 4, '09:18'));
    w.at(workday(now, 4, '10:50'));
    await w.kit.resolve(openCard(id, 'low_confidence_diagnosis').id, 'close', 'aisyah', 'Cannot reproduce on any device we have; asked the reporter to reopen with a recording.');
  });

  w.timeline.schedule(workday(now, 3, '14:00'), 'ticket dup-of: closed as a duplicate before triage', async () => {
    // Nothing is looking at the queue yet (no supervisor), so an Approver spots the duplicate first. (Only an Approver,
    // or the owner of a session working on the ticket, may close one: nobody owns a session on this ticket.)
    const id = await w.withoutSupervisor(() => file('dup-of', workday(now, 3, '14:00')));
    w.at(workday(now, 3, '14:40'));
    await w.ok('POST', `/api/tickets/${id}/close`, 'ceo', { resolution: 'duplicate', note: 'Same cause as the report about sideways receipt photos.' });
    await w.settle();
  });

  // ── in flight ──────────────────────────────────────────────────────────────────────────────────────────────
  // Critical, in UAT for two days: the customer waiting on their own sign-off (the funnel's bottleneck).
  w.timeline.schedule(now - 2.2 * DAY, 'ticket legacy-policy: in UAT, waiting on the requester', async () => {
    const at = now - 2.2 * DAY;
    const id = await file('legacy-policy', at);
    await triage(id, 'legacy-policy', at + 3 * MINUTE);
    await approveFixPlan(id, at + 55 * MINUTE, 'Critical for the customer; the fix is a validator change with tests. Approved.');
    await build(id, 'legacy-policy', at + 57 * MINUTE);
  });

  // UAT passed, go-live requested: the passkey gate is open.
  w.timeline.schedule(now - 3 * DAY, 'ticket wrong-name: at the go-live gate', async () => {
    const at = now - 3 * DAY;
    const id = await file('wrong-name', at);
    await triage(id, 'wrong-name', at + 3 * MINUTE);
    await approveFixPlan(id, at + 50 * MINUTE, 'Approved: stale customer context is a real risk with callers.');
    await build(id, 'wrong-name', at + 52 * MINUTE);
    await signOff(id, 'wrong-name', now - 6 * HOUR, 'Tried five transfers, the greeting is right every time.');
  });

  // The agents are not sure of the cause: a Builder decides what happens next.
  w.timeline.schedule(now - 20 * HOUR, 'ticket blank-login: awaiting a human', async () => {
    const at = now - 20 * HOUR;
    const id = await file('blank-login', at);
    await triage(id, 'blank-login', at + 3 * MINUTE);
  });

  // Two agents agree on the cause; the Approver has not looked at the fix plan yet.
  w.timeline.schedule(now - 7 * HOUR, 'ticket receipts: at the fix-plan gate', async () => {
    const at = now - 7 * HOUR;
    const id = await file('receipts', at);
    await triage(id, 'receipts', at + 3 * MINUTE);
  });

  // Approved, built, and the build stopped to ask the Approver whether to merge (its turn ended on that decision).
  w.timeline.schedule(now - 4 * HOUR, 'ticket duplicate: building, waiting on a decision', async () => {
    const at = now - 4 * HOUR;
    const id = await file('duplicate', at);
    await triage(id, 'duplicate', at + 3 * MINUTE);
    await approveFixPlan(id, now - 55 * MINUTE, 'High severity and real claims are duplicated; approved.');

    w.at(now - 52 * MINUTE);
    const s = w.kit.begin(buildLaunch(id).sessionId, planFor('fix', 'dedupe'));
    // The scenario that continues this conversation (demo-dedupe-resume) closes dedupe-2 and dedupe-3.
    const contextTokens = w.kit.workedUntil(s, now - 36 * MINUTE);
    const waitingSince = now - 34 * MINUTE;
    w.at(waitingSince);
    const decision = w.kit.decision({
      kind: 'agent_decision',
      test: 'main',
      title: 'Merge the retry-dedupe fix to main?',
      question: 'The fix for duplicate claim submissions is ready with a regression test. Merge to main now or hold for UAT?',
      options: [
        { id: 'merge', label: 'Merge to main' },
        { id: 'uat', label: 'Hold for UAT first' },
      ],
      rec: 'uat',
      context: '3 files changed, regression test test/claims/dedupe.test.ts passing.',
      subjectType: 'session',
      subjectId: s.sessionId,
      sessionId: s.sessionId,
      projectId: claims.id,
      requesterId: `session:${s.sessionId}`,
    });
    w.store.append({ type: 'session.turn_ended', actor: sys('supervisor'), scope: { sessionId: s.sessionId }, meta: { sessionId: s.sessionId, turn: 1, outcome: 'decision', exitCode: 0, durationMs: 1000 }, payload: {}, source: 'supervisor' });
    w.store.append({ type: 'session.lifecycle_changed', actor: sys('supervisor'), scope: { sessionId: s.sessionId }, meta: { sessionId: s.sessionId, from: 'running', to: 'waiting_decision', reason: 'open_decision' }, source: 'supervisor' });
    out.waiting = { session: s, decision, waitingSince, contextTokens };
  });

  // Filed minutes ago while aocd was not running: triage is queued and starts on claude-sim when aocd boots.
  w.timeline.schedule(now - 4 * MINUTE, 'ticket transfer-blank: triage queued', async () => {
    await file('transfer-blank', now - 4 * MINUTE);
  });

  // Filed while the supervisor was down and not looked at yet.
  w.timeline.schedule(now - 9 * MINUTE, 'ticket pdf: received', async () => {
    await w.withoutSupervisor(() => file('pdf', now - 9 * MINUTE));
  });

  return out;
}
