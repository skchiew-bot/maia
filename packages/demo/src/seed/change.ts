/**
 * Change control history (§8, §14), driven through mod-change's own API as the people would drive it: change requests
 * whose four fields the AI drafted and a developer edited or affirmed, approvals, work sessions linked to the record,
 * completion pins, gated rollbacks (verified by really running the project's acceptance test on the target), the
 * break-glass path with its post-incident record, and promotions that pass the provenance check. Every passkey gate is
 * signed through the real ceremony (./signer.ts); the AI drafts come from a scripted stand-in model.
 */
import { CHANGE_FIELDS, type BreakglassDTO, type ChangeField, type ChangeRequestDTO, type PromotionDTO, type RollbackDTO } from '@aoc/contracts';
import { FakeLlm } from '@aoc/kernel';
import { CHANGES, CHANGE_COMMITS, HOTFIXES, POST_INCIDENT, type ChangeKey } from './content';
import { commitFiles, redateTag, revParse } from './git';
import type { SimSession } from './sessions';
import { workday } from './time';
import { HOUR, MINUTE, setService, type PersonKey, type ProjectInfo, type SeedWorld } from './world';

const FIELD_ORDER: readonly ChangeField[] = CHANGE_FIELDS;

/** What the change-drafting model answers: per record, the fields of ./content.ts, with real rollback candidates. */
function scriptedDrafts(): FakeLlm {
  const llm = new FakeLlm();
  llm.on('change.draft', (req) => {
    const title = /^Title: (.+)$/m.exec(req.prompt)?.[1] ?? '';
    const tip = /Default branch: \S+ at ([0-9a-f]{40})/.exec(req.prompt)?.[1] ?? '';
    if (title.startsWith('Post-incident review')) {
      const kind = req.prompt.includes(HOTFIXES.claims.branch) ? 'claims' : 'aoc';
      const before = /was at ([0-9a-f]{40}) before/.exec(req.prompt)?.[1] ?? tip;
      return { ...POST_INCIDENT[kind], rollbackRef: before };
    }
    const spec = Object.values(CHANGES).find((c) => c.title === title);
    if (!spec) throw new Error(`the scripted drafting model has no record titled "${title}"`);
    return { ...spec.draft, rollbackRef: tip };
  });
  return llm;
}

interface Affirmation {
  /** Who affirms; the record's owner unless named. */
  by?: PersonKey;
  /** Milliseconds the field was on screen. Under 3 s without an edit is a blind confirm (§14). */
  dwellMs: number;
  append?: string;
  value?: string;
}

export function scheduleChangeControl(w: SeedWorld): void {
  const { claims, cx, aoc } = w.projects;
  const now = w.now;
  const llm = scriptedDrafts();
  /** Ids later clusters refer to. */
  const ref: Record<string, string> = {};

  /** The scripted model is only wired in while a record is drafted: other modules must not see an LLM they never had. */
  const withLlm = async <T>(fn: () => Promise<T>): Promise<T> => {
    setService(w.rt, 'llm', llm);
    try {
      return await fn();
    } finally {
      setService(w.rt, 'llm', null);
    }
  };

  const dto = (id: string, who: PersonKey = 'ceo') => w.ok<ChangeRequestDTO>('GET', `/api/changes/${id}`, who);

  async function affirm(id: string, owner: PersonKey, fields: Partial<Record<ChangeField, Affirmation>>, rollbackRef?: string): Promise<void> {
    const draft = await dto(id, owner);
    for (const field of FIELD_ORDER) {
      const a = fields[field];
      if (!a) continue;
      const drafted = draft.fields.find((f) => f.field === field)?.draft ?? '';
      const value = a.value ?? (a.append ? `${drafted}${a.append}` : drafted);
      w.at(w.clock.now() + a.dwellMs + 4_000);
      await w.ok('POST', `/api/changes/${id}/fields/${field}`, a.by ?? owner, {
        value,
        dwellMs: a.dwellMs,
        ...(field === 'rollbackPlan' ? { rollbackRef: rollbackRef ?? draft.rollbackRef } : {}),
      });
    }
  }

  /** Dwell times in a plausible spread: edited fields take longer than ones affirmed as drafted. */
  function fieldsPlan(key: ChangeKey, o: { blind?: ChangeField; by?: Partial<Record<ChangeField, PersonKey>>; only?: ChangeField[] } = {}): Partial<Record<ChangeField, Affirmation>> {
    const spec = CHANGES[key];
    const out: Partial<Record<ChangeField, Affirmation>> = {};
    FIELD_ORDER.forEach((field, i) => {
      if (o.only && !o.only.includes(field)) return;
      const edit = spec.edits[field];
      out[field] = {
        by: o.by?.[field],
        dwellMs: o.blind === field ? 1_300 : edit ? 52_000 + i * 9_000 : 16_000 + i * 4_000,
        ...(edit?.append ? { append: edit.append } : {}),
        ...(edit?.value ? { value: edit.value } : {}),
      };
    });
    return out;
  }

  async function draftChange(key: ChangeKey): Promise<string> {
    const spec = CHANGES[key];
    const project = { claims, cx, aoc }[spec.project];
    const created = await w.ok<ChangeRequestDTO>('POST', '/api/changes', spec.owner, { projectId: project.id, scope: spec.scope, title: spec.title });
    return created.changeId;
  }

  /** The work session of an approved record: launched under it, linked by `start`, committing with its trailers. */
  async function work(key: ChangeKey, changeId: string, at: number): Promise<{ session: SimSession; branch: string; sha: string }> {
    const spec = CHANGES[key];
    const commit = CHANGE_COMMITS[key]!;
    const project = { claims, cx, aoc }[spec.project];
    const owner = w.people[spec.owner];
    const branch = `change/${key}`;
    w.at(at);
    const plan = {
      phases: [
        {
          id: 'change',
          name: 'Change',
          tasks: [
            { id: `chg-${key}-1`, title: commit.message, size: 'm' as const },
            { id: `chg-${key}-2`, title: 'Acceptance test green', size: 's' as const },
          ],
        },
      ],
    };
    const s = w.kit.launch(owner.userId, project, 'feature-build', `Implement change ${changeId}: ${spec.title}`, {
      thread: `thr_${project.slug}_${key}`,
      changeId,
      plan,
    });
    s.branch = branch;
    await w.ok('POST', `/api/changes/${changeId}/start`, spec.owner, { sessionId: s.sessionId });
    w.kit.declare(s, w.kit.treeOf(project));
    w.kit.tools(s, 7, 14 * MINUTE);
    const sha = w.kit.commit(s, commit.message, commit.files, [`AOC-Change: ${changeId}`]);
    w.kit.usage(s, 9, 80_000);
    w.kit.done(s, plan.phases[0]!.tasks[0]!.id, 'change', 'm', { commit: sha, detail: 'Committed on the change branch' });
    w.kit.tools(s, 4, 6 * MINUTE);
    const last = w.kit.done(s, plan.phases[0]!.tasks[1]!.id, 'change', 's', { kind: 'test', detail: 'node --test test/acceptance.test.mjs: all green' });
    w.kit.phaseDone(s, 'change', last, sha);
    w.kit.end(s);
    await w.settle();
    return { session: s, branch, sha };
  }

  /** Completes the record. The platform pins it with the wall clock, so the tag is re-dated to the moment of the record. */
  async function complete(id: string, project: ProjectInfo, who: PersonKey, body: { ref?: string } = {}): Promise<void> {
    await w.ok('POST', `/api/changes/${id}/complete`, who, body);
    redateTag(project.repo, `aoc/change/${id}`, w.clock.now());
  }

  async function submitAndApprove(id: string, owner: PersonKey, comment: string): Promise<ChangeRequestDTO> {
    const submitted = await w.ok<ChangeRequestDTO>('POST', `/api/changes/${id}/submit`, owner);
    if (submitted.status === 'approved') return submitted;
    w.at(w.clock.now() + 38 * MINUTE);
    await w.kit.resolve(submitted.decisionId!, 'approve', 'ceo', comment);
    return dto(id);
  }

  async function requestPromotion(projectId: string, owner: PersonKey, fromRef: string, changeId: string): Promise<PromotionDTO> {
    return w.ok<PromotionDTO>('POST', '/api/promotions', owner, { projectId, fromRef, changeId });
  }

  /** The emergency path: hotfix written during the outage, invoked, signed with a passkey, promoted past provenance. */
  async function breakglass(kind: 'claims' | 'aoc', project: ProjectInfo, invoker: PersonKey, invokeAt: number, approveAt: number): Promise<BreakglassDTO> {
    const hotfix = HOTFIXES[kind];
    const person = w.people[invoker];
    commitFiles(project.repo, { branch: hotfix.branch, files: hotfix.file, message: hotfix.message, author: person.author, at: invokeAt - 20 * MINUTE });
    w.at(invokeAt);
    const bg = await w.ok<BreakglassDTO>('POST', '/api/breakglass', invoker, { projectId: project.id, ref: hotfix.branch, justification: hotfix.justification });
    w.at(approveAt);
    await w.signer.resolve(bg.decisionId, 'approve', 'ceo', 'Approved: production is down and the fix is a one-file change; the post-incident record is due.');
    return w.ok<BreakglassDTO>('GET', `/api/breakglass/${bg.breakglassId}`, 'ceo');
  }

  // ── claims-bot: a main-scope change promoted through the gate, then rolled back ──────────────────────────────
  w.timeline.schedule(workday(now, 8, '16:10'), 'change: cap OCR retries (promoted)', () =>
    withLlm(async () => {
      const key: ChangeKey = 'ocr-cap';
      const spec = CHANGES[key];
      w.at(workday(now, 8, '16:10'));
      const base = revParse(claims.repo, 'refs/heads/main')!;
      const id = await draftChange(key);
      // The Approver tightens the acceptance command herself: one record, fields affirmed by two people.
      await affirm(id, spec.owner, fieldsPlan(key, { by: { acceptanceTest: 'ceo' } }), base);
      ref.ocrCap = id;
      ref.ocrCapBase = base;
      await submitAndApprove(id, spec.owner, 'Approved: the rollback point is recorded and the cap is a one-line change.');
      w.at(w.clock.now() + 12 * MINUTE);
      const done = await work(key, id, w.clock.now());
      await complete(id, claims, spec.owner, { ref: done.branch });
      w.at(w.clock.now() + 6 * MINUTE);
      const promotion = await requestPromotion(claims.id, spec.owner, done.branch, id);
      w.at(w.clock.now() + 41 * MINUTE);
      await w.signer.resolve(promotion.decisionId!, 'approve', 'ceo', 'Every commit traces to the approved change; go live.');
    }),
  );

  w.timeline.schedule(workday(now, 7, '10:30'), 'rollback: undo the OCR retry cap (executed)', async () => {
    w.at(workday(now, 7, '10:30'));
    const rollback = await w.ok<RollbackDTO>('POST', '/api/rollbacks', 'aisyah', {
      projectId: claims.id,
      targetRef: ref.ocrCapBase,
      changeId: ref.ocrCap,
      reason: 'Slow scans of large forms are sent to manual review after three attempts and the adjusters cannot keep up. Return to the state before the cap.',
    });
    await w.settle();
    const verified = await w.ok<RollbackDTO>('GET', `/api/rollbacks/${rollback.rollbackId}`, 'ceo');
    if (verified.status !== 'awaiting_approval') throw new Error(`rollback ${rollback.rollbackId} is ${verified.status}, not awaiting approval: ${verified.verification?.report ?? ''}`);
    w.at(w.clock.now() + 47 * MINUTE);
    await w.signer.resolve(verified.decisionId!, 'approve', 'ceo', 'Clean on the rollback branch (acceptance test passed); roll main back.');
    ref.rollbackOcr = rollback.rollbackId;
  });

  // ── claims-bot: a break-glass at night, its post-incident record filed the same morning ─────────────────────
  w.timeline.schedule(workday(now, 3, '02:10'), 'break-glass: claim intake retry stampede (closed)', () =>
    withLlm(async () => {
      const at = workday(now, 3, '02:10');
      const bg = await breakglass('claims', claims, 'aisyah', at, at + 14 * MINUTE);
      const id = bg.postIncidentChangeId!;
      // The record is due within 24 hours of the approval; Aisyah files it at 09:40 the same morning.
      w.at(at + 7 * HOUR + 30 * MINUTE);
      const draft = await dto(id, 'aisyah');
      for (const field of FIELD_ORDER) {
        const drafted = draft.fields.find((f) => f.field === field)?.draft ?? '';
        w.at(w.clock.now() + 70_000);
        await w.ok('POST', `/api/changes/${id}/fields/${field}`, 'aisyah', {
          value: field === 'impact' ? `${drafted} Customers saw an error on every submission for about forty minutes.` : drafted,
          dwellMs: field === 'impact' ? 95_000 : 21_000,
          ...(field === 'rollbackPlan' ? { rollbackRef: draft.rollbackRef } : {}),
        });
      }
      await submitAndApprove(id, 'aisyah', 'Reviewed: the record matches what the hotfix changed.');
      w.at(w.clock.now() + 14 * MINUTE);
      await complete(id, claims, 'aisyah');
      ref.breakglassClaims = bg.breakglassId;
    }),
  );

  // ── claims-bot: a production-scope change waiting for the Approver ──────────────────────────────────────────
  w.timeline.schedule(now - 26 * HOUR, 'change: validator rollout (submitted)', () =>
    withLlm(async () => {
      const key: ChangeKey = 'validator-rollout';
      w.at(now - 26 * HOUR);
      const id = await draftChange(key);
      await affirm(id, CHANGES[key].owner, fieldsPlan(key));
      w.at(w.clock.now() + 3 * MINUTE);
      await w.ok('POST', `/api/changes/${id}/submit`, CHANGES[key].owner);
    }),
  );

  // ── cx-copilot: reversible, off-main, self-approved by its developer (one blind confirm) ───────────────────
  w.timeline.schedule(workday(now, 6, '15:00'), 'change: whisper telemetry (self-approved)', () =>
    withLlm(async () => {
      const key: ChangeKey = 'whisper-telemetry';
      w.at(workday(now, 6, '15:00'));
      const id = await draftChange(key);
      await affirm(id, CHANGES[key].owner, fieldsPlan(key, { blind: 'mitigation' }));
      await submitAndApprove(id, CHANGES[key].owner, '');
      w.at(w.clock.now() + 9 * MINUTE);
      const done = await work(key, id, w.clock.now());
      await complete(id, cx, CHANGES[key].owner, { ref: done.branch });
    }),
  );

  // ── cx-copilot: a drafted record, two of four fields affirmed ──────────────────────────────────────────────
  w.timeline.schedule(now - 27 * HOUR, 'change: dispatch timeouts (draft)', () =>
    withLlm(async () => {
      const key: ChangeKey = 'dispatch-timeouts';
      w.at(now - 27 * HOUR);
      const id = await draftChange(key);
      await affirm(id, CHANGES[key].owner, fieldsPlan(key, { only: ['impact', 'mitigation'] }));
    }),
  );

  // ── aoc-platform: a data change, an open break-glass inside its 24 hours and a verified rollback at the gate ──
  w.timeline.schedule(workday(now, 5, '11:00'), 'change: September rollup backfill (completed)', () =>
    withLlm(async () => {
      const key: ChangeKey = 'rollup-backfill';
      const spec = CHANGES[key];
      w.at(workday(now, 5, '11:00'));
      const id = await draftChange(key);
      await affirm(id, spec.owner, fieldsPlan(key));
      await submitAndApprove(id, spec.owner, 'Approved for data: dry run first, backup verified.');
      w.at(w.clock.now() + 10 * MINUTE);
      const done = await work(key, id, w.clock.now());
      await complete(id, aoc, spec.owner, { ref: done.branch });
      ref.rollupBackfill = id;
    }),
  );

  w.timeline.schedule(now - 9.7 * HOUR, 'break-glass: console readiness (open, post-incident due)', () =>
    withLlm(async () => {
      const at = now - 9.7 * HOUR;
      const bg = await breakglass('aoc', aoc, 'weijie', at, at + 17 * MINUTE);
      // Wei Jie has started the record and affirmed the impact; three fields are left before the deadline.
      const id = bg.postIncidentChangeId!;
      const draft = await dto(id, 'weijie');
      w.at(now - 6 * HOUR);
      await w.ok('POST', `/api/changes/${id}/fields/impact`, 'weijie', {
        value: `${draft.fields.find((f) => f.field === 'impact')?.draft ?? ''} Instances behind the load balancer returned an empty page until the event store opened.`,
        dwellMs: 88_000,
      });
      ref.breakglassAoc = bg.breakglassId;
    }),
  );

  w.timeline.schedule(now - 2.4 * HOUR, 'rollback: revert to the backfill pin (awaiting the passkey)', async () => {
    w.at(now - 2.4 * HOUR);
    const rollback = await w.ok<RollbackDTO>('POST', '/api/rollbacks', 'priya', {
      projectId: aoc.id,
      targetRef: `aoc/change/${ref.rollupBackfill}`,
      changeId: ref.rollupBackfill,
      reason: 'The readiness hotfix is a stopgap; return to the state pinned by the rollup backfill while the permanent fix is built.',
    });
    await w.settle();
    const verified = await w.ok<RollbackDTO>('GET', `/api/rollbacks/${rollback.rollbackId}`, 'ceo');
    if (verified.status !== 'awaiting_approval') throw new Error(`rollback ${rollback.rollbackId} is ${verified.status}, not awaiting approval: ${verified.verification?.report ?? ''}`);
    ref.rollbackAoc = rollback.rollbackId;
  });
}
