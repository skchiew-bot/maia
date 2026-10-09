/**
 * (j) Evidence pack (§11): a day of governed work with a distinctive secret in every free-text field a person or an
 * agent fills — launch prompt, plan, shell command, file contents, evidence note, decision text and comment, intake
 * ticket and attachment name, triage diagnosis, top-up reason, a requester's name, transcript text. The secrets sit
 * in encrypted bodies; the chained headers, and so the pack over the date range, carry none of them.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { EvidencePackManifest, InternalTicket, PublicTicket } from '@aoc/contracts';
import { addDays, localDate } from '@aoc/kernel';
import { ClaudeSession } from './claude';
import { Harness, waitFor } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await Harness.start();
});
afterAll(async () => {
  await h?.close();
});

const S = {
  requesterName: 'Zqxname Binti Rahmat',
  launchPrompt: 'zqx-launch-4417',
  planSummary: 'zqx-plan-2290',
  taskTitle: 'zqx-task-8812',
  bashCommand: 'zqx-bash-3305',
  fileContent: 'zqx-file-7741',
  evidenceDetail: 'zqx-evidence-1196',
  decisionQuestion: 'zqx-question-6620',
  decisionOption: 'zqx-option-5583',
  decisionComment: 'zqx-comment-9034',
  ticketText: 'zqx-ticket-3378',
  attachmentName: 'zqx-attachment-2251',
  rootCause: 'zqx-root-cause-6067',
  rootCauseClass: 'zqx-class-1474',
  fixPlan: 'zqx-fix-plan-8140',
  topupReason: 'zqx-topup-5521',
  transcriptText: 'zqx-transcript-9908',
} as const;
type SecretKey = keyof typeof S;

/** Which secrets appear in `text` (case-insensitive: a slug of a secret is still the secret). */
const secretsIn = (text: string): SecretKey[] => {
  const t = text.toLowerCase();
  return (Object.keys(S) as SecretKey[]).filter((k) => t.includes(S[k].toLowerCase()));
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('e2e-evidence-bytes')]);

describe('(j) evidence pack', () => {
  it('a day of governed work seeded with secrets → the pack over the range holds no payload text', async () => {
    const dev = await h.user('builder', 'Dev');
    const ceo = await h.user('approver', 'CEO');
    const requester = await h.user('requester', S.requesterName);
    const { projectId } = await h.project(dev, 'Payroll');

    // A managed session through the real hook binary, MCP server and sidecar.
    const s = await h.launch(dev, { projectId, processType: 'feature-build', prompt: `Fix the payroll rounding for ${S.launchPrompt}` });
    const claude = new ClaudeSession(h, s);
    claude.startSidecar();
    await claude.start();
    const said = claude.transcript.assistant({ input: 10, output: 200 }, [{ type: 'text', text: `Looking at ${S.transcriptText}` }]);
    const plan = await claude.aoc('declare_plan', {
      summary: `Payroll rounding ${S.planSummary}`,
      phases: [{ id: 'p1', name: 'Fix', tasks: [{ id: 't1', title: `Round ${S.taskTitle}`, size: 's' }, { id: 't2', title: 'Release', size: 's' }] }],
    });
    expect(plan.isError).toBe(false);
    expect((await claude.bash(`echo "${S.bashCommand}" > notes.txt`)).decision).toBe('allow');
    expect((await claude.write('src/payroll.ts', `export const note = '${S.fileContent}';\n`)).decision).toBe('allow');
    const done = await claude.aoc('task_done', { task_id: 't1', evidence: { kind: 'diff', ref: 'src/payroll.ts', detail: `checked ${S.evidenceDetail}` } });
    expect(done.data).toMatchObject({ ok: true });
    const asked = await claude.aoc('request_decision', {
      test: 'ambiguity',
      question: `Round half-up or banker's rounding for ${S.decisionQuestion}?`,
      options: [
        { id: 'half_up', label: `Half-up ${S.decisionOption}` },
        { id: 'bankers', label: "Banker's rounding" },
      ],
      recommendation: { option_id: 'half_up', rationale: 'Matches the statutory tables.' },
      context: `Seen in ${S.decisionQuestion}`,
    });
    const decisionId = asked.data.decision_id as string;
    await h.api('POST', `/api/decisions/${decisionId}/resolve`, { as: ceo, body: { optionId: 'half_up', comment: `Use half-up, ${S.decisionComment}` } });
    // The sidecar meters usage (ids and numbers only) from the transcript.
    await claude.sidecarProc!.stop();
    await waitFor(
      () => h.events({ types: ['usage.recorded'], sessionId: s.sessionId }).some((e) => (h.store.readPayload(e) as { messageIds: string[] }).messageIds.includes(said)),
      { what: 'usage from the sidecar' },
    );
    await h.api('POST', '/api/credits/topup-requests', { as: dev, body: { amountUsd: 10, reason: `Payroll crunch ${S.topupReason}`, sessionId: s.sessionId }, expect: 201 });

    // An intake ticket, triaged by a read-only session that reports through the MCP server.
    const form = new FormData();
    form.set('title', `Payslip rounding ${S.ticketText}`);
    form.set('description', `My payslip is off by a cent (${S.ticketText}).`);
    form.set('severity', 'medium');
    form.set('projectId', projectId);
    form.append('files', new File([PNG], `${S.attachmentName}.png`, { type: 'image/png' }));
    const res = await fetch(`${h.url}/portal/api/intakes`, { method: 'POST', headers: requester.headers, body: form });
    expect(res.status).toBe(201);
    const ticket = (await res.json()) as PublicTicket;
    const triage = await waitFor(() => [...h.stub.sessions.values()].find((x) => x.ticketId === ticket.ticketId), { what: 'the triage launch' });
    expect(triage.readOnly).toBe(true);
    const triager = new ClaudeSession(h, triage);
    await triager.start();
    const diagnosis = await triager.aoc('report_diagnosis', {
      root_cause: `Rounding happens before tax for ${S.rootCause}`,
      confidence: 0.9,
      fix_plan: `Round after tax; ${S.fixPlan}`,
      root_cause_class: S.rootCauseClass,
    });
    expect(diagnosis.isError).toBe(false);
    await waitFor(async () => (await h.api<InternalTicket>('GET', `/api/tickets/${ticket.ticketId}`, { as: dev })).stage === 'fix_plan_gate', { what: 'the fix-plan gate' });

    // Every secret but the transcript text reached an encrypted body (the transcript never leaves the host)...
    const events = h.events();
    const bodies = events.map((e) => JSON.stringify(h.store.readPayload(e) ?? null)).join('\n');
    expect((Object.keys(S) as SecretKey[]).filter((k) => !secretsIn(bodies).includes(k))).toEqual(['transcriptText']);
    // ...and no chained header (meta, scope, actor, idempotency key) carries any of them.
    const leaked = events.flatMap((e) => secretsIn(JSON.stringify(e)).map((k) => `${e.type}: ${k}`));
    expect(leaked).toEqual([]);

    // The pack over yesterday..today (local), as a builder generates and downloads it.
    const today = localDate(Date.now(), 'Asia/Kuala_Lumpur');
    const from = addDays(today, -1);
    const pack = await h.api<{ packId: string; manifest: EvidencePackManifest }>('POST', '/api/evidence/packs', { as: dev, body: { from, to: today }, expect: 201 });
    expect(pack.manifest.verification).toMatchObject({ ok: true, chainOk: true });
    const dl = await h.request('GET', `/api/evidence/packs/${pack.packId}/download`, { as: dev });
    expect(dl.status).toBe(200);
    const zip = new Uint8Array(await dl.arrayBuffer());
    expect(dl.headers.get('x-aoc-pack-sha256')).toBe(createHash('sha256').update(zip).digest('hex'));
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(
      ['breakglass.json', 'changes.json', 'controls.json', 'credits.json', 'events.jsonl', 'fx.json', 'gates.json', 'index.html', 'manifest.json', 'rollbacks.json', 'verification.json'],
    );
    const lines = strFromU8(files['events.jsonl']!).trim().split('\n').map((l) => JSON.parse(l) as { type: string; seq: number });
    // The pack covers the work (not vacuously clean): every event of the range, in order.
    expect(lines.map((l) => l.seq)).toEqual(events.map((e) => e.seq).filter((seq) => seq <= pack.manifest.head.seq));
    const types = new Set(lines.map((l) => l.type));
    for (const type of [
      'user.created',
      'session.launch_requested',
      'prompt.submitted',
      'plan.declared',
      'tool.used',
      'task.done',
      'decision.requested',
      'decision.resolved',
      'usage.recorded',
      'credit.topup_requested',
      'intake.submitted',
      'ticket.diagnosis_reported',
    ])
      expect(types.has(type), type).toBe(true);
    const inPack = Object.entries(files).flatMap(([name, bytes]) => secretsIn(strFromU8(bytes)).map((k) => `${name}: ${k}`));
    expect(inPack).toEqual([]);
    await claude.close();
    await triager.close();
    expect(h.store.verifyChain().ok).toBe(true);
  });
});
