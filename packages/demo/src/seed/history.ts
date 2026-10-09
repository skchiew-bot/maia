/**
 * Fourteen days of finished sessions across the three projects: plan manifests, tool calls, usage, task closes with
 * evidence, phase pins (real commits and tags), the odd agent decision and the playbooks that move feature builds and
 * test repairs to the cheaper model. Governed work (change records, tickets, break-glass) scheduled on the timeline
 * runs between the sessions, in time order.
 */
import { newId } from '@aoc/contracts';
import { localDate } from '@aoc/kernel';
import { between, pick, rnd } from './rng';
import { DAY, HOUR, human, type SeedWorld } from './world';

const TZ = 'Asia/Kuala_Lumpur';
const BUILDERS = ['aisyah', 'weijie', 'priya'] as const;
const SESSION_TYPES = ['discovery', 'feature-build', 'feature-build', 'bug-fix', 'test-repair', 'docs'] as const;

/** Playbooks distilled from discovery runs; once approved, feature-build and test-repair run on the cheaper model. */
async function approvePlaybooks(w: SeedWorld): Promise<void> {
  for (const [type, title] of [
    ['feature-build', 'Feature build playbook v1'],
    ['test-repair', 'Flaky test repair playbook'],
  ] as const) {
    const playbookId = newId('playbook', w.clock.now());
    const dec = w.kit.decision({
      kind: 'playbook_approval',
      title: `Approve playbook: ${title}`,
      question: `Bind "${title}" so ${type} runs execute on the cheaper model?`,
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      rec: 'approve',
      subjectType: 'playbook',
      subjectId: playbookId,
      requesterId: w.people.priya.userId,
    });
    w.store.append({
      type: 'playbook.proposed',
      actor: human(w.people.priya.userId),
      scope: {},
      meta: { playbookId, processType: type, sourceSessionId: null, version: 1, stepCount: 4, decisionId: dec.id, method: 'llm' },
      payload: {
        title,
        steps: [
          { id: 's1', title: 'Reproduce / map the change surface' },
          { id: 's2', title: 'Write the acceptance test first' },
          { id: 's3', title: 'Implement the smallest change' },
          { id: 's4', title: 'Run the full suite and close tasks with evidence' },
        ],
      },
      source: 'api',
    });
    w.at(w.clock.now() + 3 * HOUR);
    await w.kit.resolve(dec.id, 'approve', 'ceo', 'Approved for execution runs.');
  }
}

export async function seedHistory(w: SeedWorld): Promise<void> {
  const { t0, days } = w;
  const projects = Object.values(w.projects);
  for (let d = 0; d < days; d++) {
    if (d === 5) {
      // The evening before day 5: later feature-build and test-repair runs are routed to the execution model.
      w.at(t0 + 5 * DAY - 7 * HOUR);
      await approvePlaybooks(w);
    }
    const dayStart = t0 + d * DAY + 1.5 * HOUR; // 09:30 local when seeded at 08:00
    const dow = new Date(`${localDate(dayStart, TZ)}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (let k = 0; k < between(2, 4); k++) {
      const start = dayStart + k * 2.2 * HOUR + between(0, 1800_000);
      await w.timeline.runDue(start, w.clock);
      w.at(start);
      const owner = pick(BUILDERS);
      const project = pick(projects);
      const type = pick(SESSION_TYPES);
      const s = w.kit.launch(
        w.people[owner].userId,
        project,
        type,
        `${pick(['Add', 'Fix', 'Refactor', 'Instrument'])} ${pick(['agent handover summary', 'claims OCR fallback', 'SLA breach alerting', 'queue rebalancer', 'CSAT survey hook', 'PDPA export'])} for ${project.name}`,
      );
      w.kit.tools(s, between(4, 8), between(60_000, 300_000));
      w.kit.declare(s);
      let ctx = 24_000;
      for (const ph of s.plan.phases) {
        let closing: ReturnType<typeof w.kit.done> | null = null;
        for (const task of ph.tasks) {
          w.kit.tools(s, between(6, 22), between(4, 18) * 60_000);
          ctx += between(6_000, 30_000);
          w.kit.usage(s, between(6, 26), ctx);
          closing = w.kit.done(s, task.id, ph.id, task.size, { flag: rnd() < 0.05 ? 'no_file_change' : null });
        }
        w.kit.phaseDone(s, ph.id, closing!);
      }
      if (rnd() < 0.25) {
        const test = pick(['irreversible', 'ambiguity'] as const);
        const dec = w.kit.decision({
          kind: 'agent_decision',
          test,
          title: 'Pick a persistence strategy',
          question: 'Event table or document store for the handover summaries?',
          options: [
            { id: 'events', label: 'Append-only event table' },
            { id: 'docs', label: 'Document store' },
          ],
          rec: 'events',
          subjectType: 'session',
          subjectId: s.sessionId,
          sessionId: s.sessionId,
          projectId: project.id,
          requesterId: `session:${s.sessionId}`,
        });
        w.at(w.clock.now() + between(10, 90) * 60_000);
        // Irreversible choices bounce to the Approver; ambiguity is answered by a Builder (§6).
        await w.kit.resolve(dec.id, 'events', test === 'irreversible' ? 'ceo' : pick(BUILDERS.filter((b) => b !== owner)), 'Keep it append-only; we need the audit trail.');
      }
      w.kit.end(s);
    }
  }
}
