/**
 * Authorization matrix over every route of the production composition (spec §3, §6, §7).
 *
 * Every (method, path) the daemon registers is called anonymously and as each kind of principal with an empty
 * body, and each answer is compared with the audience the route is meant to have. The expectation table below is
 * the independent statement of that intent: a route nobody classified fails the test, so a new endpoint cannot
 * ship without someone deciding who may call it.
 *
 *   .  401 unauthenticated      x  403 forbidden      +  passed authorization (2xx/4xx for the empty body)      !  5xx
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, hasPermission, type Permission, type Role } from '@aoc/contracts';
import { identityServiceOf } from '@aoc/mod-identity';
import { bootProd, type Prod } from './support/prod';

// ── the role model, frozen against the spec (§6) ─────────────────────────────────────────────────────────

/** What only the Approver (the CEO, who holds the gates) may do. */
const APPROVER_ONLY: Permission[] = [
  'audit.backup',
  'audit.erase',
  'credit.allocate',
  'credit.topup_approve',
  'credit.view_all',
  'gate.approve',
  'ops.admin',
  'ratecard.edit',
  'session.drive_any',
  'ticket.close_any',
  'ticket.media_view',
  'users.manage',
];
/** What the Requester (end user) may do, and nothing else (§7). */
const REQUESTER_PERMS: Permission[] = ['intake.submit', 'intake.view_own', 'uat.signoff_own'];
/** Intake permissions the Approver holds besides the requester (the CEO may file a bug too). */
const APPROVER_ALSO_INTAKE: Permission[] = ['intake.submit', 'intake.view_own'];

describe('the three-role access model (§6)', () => {
  it('Requesters hold exactly the intake permissions; Builders never hold a gate; only the Approver holds the Approver set', () => {
    expect([...ROLE_PERMISSIONS.requester].sort()).toEqual([...REQUESTER_PERMS].sort());
    for (const p of APPROVER_ONLY) {
      expect(hasPermission('approver', p), `approver ${p}`).toBe(true);
      expect(hasPermission('builder', p), `builder ${p}`).toBe(false);
      expect(hasPermission('requester', p), `requester ${p}`).toBe(false);
    }
    for (const p of REQUESTER_PERMS.filter((x) => !APPROVER_ALSO_INTAKE.includes(x))) {
      expect(hasPermission('approver', p), `approver ${p}`).toBe(false);
      expect(hasPermission('builder', p), `builder ${p}`).toBe(false);
    }
    for (const p of APPROVER_ALSO_INTAKE) expect(hasPermission('builder', p), `builder ${p}`).toBe(false);
  });

  it('classifies every permission, so a new one needs a decision here', () => {
    const classified = new Set<Permission>([...APPROVER_ONLY, ...REQUESTER_PERMS, 'mapping.stamp']);
    const shared = PERMISSIONS.filter((p) => !classified.has(p));
    // Everything left is the Builder's working set, which the Approver also holds.
    for (const p of shared) {
      expect(hasPermission('builder', p), `builder ${p}`).toBe(true);
      expect(hasPermission('approver', p), `approver ${p}`).toBe(true);
      expect(hasPermission('requester', p), `requester ${p}`).toBe(false);
    }
  });

  it('mapping.stamp is never granted by role: only the compliance-lead flag, and never to a Requester (R3)', () => {
    for (const role of ['approver', 'builder', 'requester'] as Role[]) {
      expect(hasPermission(role, 'mapping.stamp', {}), `${role} without the flag`).toBe(false);
      expect(hasPermission(role, 'mapping.stamp', { complianceLead: true }), `${role} with the flag`).toBe(role !== 'requester');
    }
  });
});

// ── who may call what ────────────────────────────────────────────────────────────────────────────────────

/** public: anyone · user: any signed-in person · ingest: a session/observer/system token · otherwise a permission. */
type Aud = 'public' | 'user' | 'ingest' | Permission;

const ROUTES: Record<string, Aud> = {
  // identity
  'POST /api/auth/login': 'public',
  'POST /api/auth/logout': 'public',
  'GET /api/auth/me': 'user',
  'GET /api/directory': 'audit.view',
  'GET /api/users': 'users.manage',
  'POST /api/users': 'users.manage',
  'PATCH /api/users/:id': 'users.manage',
  'POST /api/users/:id/tokens': 'users.manage',
  'GET /api/users/:id/tokens': 'users.manage', // a person may also list their own (see "own resources")
  'GET /api/tokens': 'users.manage',
  'DELETE /api/tokens/:id': 'users.manage', // revoking one's own token is also allowed
  'POST /api/tokens/observer': 'users.manage',
  'POST /api/passkeys/register/options': 'user',
  'POST /api/passkeys/register/verify': 'user',
  'GET /api/passkeys': 'user',
  'DELETE /api/passkeys/:id': 'user',
  'POST /api/passkeys/assert/options': 'user',
  // registry, learning
  'GET /api/registry': 'registry.view',
  'GET /api/registry/process-types': 'registry.view',
  'GET /api/registry/runs': 'registry.view',
  'GET /api/playbooks': 'registry.view',
  'GET /api/playbooks/:id': 'registry.view',
  'POST /api/playbooks/distill': 'learning.curate',
  'POST /api/playbooks/:id/retire': 'learning.curate',
  'GET /api/knowledge/search': 'learning.view',
  'GET /api/learning/errors': 'learning.view',
  'POST /api/learning/errors/:id/root-cause': 'learning.curate',
  'GET /api/learning/classes': 'learning.view',
  'POST /api/learning/classes': 'learning.curate',
  'GET /api/learning/offences': 'learning.view',
  'POST /api/learning/offences/:id/transition': 'learning.curate',
  'GET /api/learning/trends': 'learning.view',
  'GET /api/learning/model-dimension': 'learning.view',
  'GET /api/learning/lessons': 'learning.view',
  'POST /api/learning/lessons': 'learning.curate',
  'POST /api/learning/lessons/:id/retire': 'learning.curate',
  // sessions
  'POST /ingest/hook': 'ingest',
  'POST /ingest/spool': 'ingest',
  'POST /ingest/heartbeat': 'ingest',
  'POST /ingest/activity': 'ingest',
  'POST /ingest/usage': 'ingest',
  'POST /ingest/throttle': 'ingest',
  'POST /ingest/process': 'ingest',
  // the push gateway: git smart HTTP, a managed session's own token only (the finer rules: authz-surface.test.ts)
  'GET /ingest/git/:repo/info/refs': 'ingest',
  'POST /ingest/git/:repo/git-receive-pack': 'ingest',
  'GET /api/console': 'session.view',
  'GET /api/sessions': 'session.view',
  'GET /api/sessions/:id': 'session.view',
  'GET /api/sessions/:id/activity': 'session.view',
  'GET /api/sessions/:id/events': 'session.view',
  'GET /api/sessions/:id/timeline': 'session.view',
  'POST /api/sessions': 'session.launch',
  'GET /api/sessions/:id/output': 'session.view',
  'POST /api/sessions/:id/prompt': 'session.drive_own',
  'POST /api/sessions/:id/nudge': 'session.drive_own',
  'POST /api/sessions/:id/restart': 'session.drive_own',
  'POST /api/sessions/:id/stop': 'session.drive_own',
  'POST /api/threads/:id/rollover': 'session.drive_own',
  // decisions
  'GET /api/decisions/summary': 'decision.view',
  'GET /api/decisions': 'decision.view',
  'GET /api/decisions/:id': 'decision.view',
  'POST /api/decisions/:id/resolve': 'decision.resolve',
  'POST /api/decisions/:id/withdraw': 'decision.view',
  'POST /api/decisions/:id/escalate': 'decision.resolve',
  // the agent's structured voice
  'POST /ingest/mcp/request_decision': 'ingest',
  'POST /ingest/mcp/declare_plan': 'ingest',
  'POST /ingest/mcp/amend_plan': 'ingest',
  'POST /ingest/mcp/task_done': 'ingest',
  'POST /ingest/mcp/playbook_step': 'ingest',
  'POST /ingest/mcp/get_status': 'ingest',
  'POST /ingest/mcp/report_error': 'ingest',
  'POST /ingest/mcp/report_diagnosis': 'ingest',
  // ledger
  'GET /api/projects': 'session.view',
  'POST /api/projects': 'project.manage',
  'GET /api/projects/rollup': 'session.view',
  'GET /api/projects/:id': 'session.view',
  'PATCH /api/projects/:id': 'project.manage',
  'GET /api/projects/:id/timeline': 'session.view',
  'GET /api/projects/:id/history': 'session.view',
  'POST /api/projects/:id/threads': 'project.manage',
  'POST /api/projects/:id/enhancements': 'project.manage',
  'GET /api/threads/:id': 'session.view',
  // metering, fx, credits
  'GET /api/metering/summary': 'audit.view',
  'GET /api/metering/daily': 'audit.view',
  'GET /api/metering/throttle': 'audit.view',
  'GET /api/metering/sessions/:id': 'audit.view',
  'GET /api/metering/cost-per-outcome': 'audit.view',
  'GET /api/metering/migration': 'audit.view',
  'GET /api/ratecard': 'audit.view',
  'GET /api/ratecard/versions': 'audit.view',
  'PUT /api/ratecard': 'ratecard.edit',
  'GET /api/metering/subscription': 'audit.view',
  'PUT /api/metering/subscription': 'ratecard.edit',
  'GET /api/fx/rates': 'audit.view',
  'GET /api/fx/status': 'audit.view',
  'POST /api/fx/run': 'ratecard.edit',
  'POST /api/fx/rates/:date/override': 'ratecard.edit',
  'GET /api/credits/me': 'credit.topup_request',
  'GET /api/credits/accounts': 'credit.view_all',
  'POST /api/credits/allocations': 'credit.allocate',
  'POST /api/credits/topup-requests': 'credit.topup_request',
  'GET /api/credits/topup-requests': 'credit.topup_request',
  // change control
  'POST /api/changes': 'change.create',
  'GET /api/changes': 'audit.view',
  'GET /api/changes/:id': 'audit.view',
  'POST /api/changes/:id/fields/:field': 'change.create',
  'POST /api/changes/:id/submit': 'change.create',
  'POST /api/changes/:id/start': 'change.create',
  'POST /api/changes/:id/complete': 'change.create',
  'GET /api/governance/affirm-rate': 'gate.approve',
  'GET /api/pins': 'audit.view',
  'POST /api/rollbacks': 'rollback.request',
  'GET /api/rollbacks': 'audit.view',
  'GET /api/rollbacks/:id': 'audit.view',
  'POST /api/breakglass': 'breakglass.invoke',
  'GET /api/breakglass': 'audit.view',
  'GET /api/breakglass/:id': 'audit.view',
  'POST /api/promotions': 'promotion.request',
  'GET /api/promotions': 'audit.view',
  'GET /api/promotions/:id': 'audit.view',
  'GET /api/provenance': 'audit.view',
  // audit, compliance, evidence
  'GET /api/audit/events': 'audit.view',
  'GET /api/audit/events/:seq': 'audit.view',
  'GET /api/audit/anchors': 'audit.view',
  'GET /api/audit/health': 'audit.view',
  'GET /api/audit/verify': 'audit.verify',
  'POST /api/audit/anchor': 'audit.verify',
  'GET /api/audit/backups': 'audit.view',
  'POST /api/audit/backup': 'audit.backup',
  'POST /api/audit/erase': 'audit.erase',
  'POST /api/audit/erasure-requests': 'audit.erase_request',
  'GET /api/compliance/mapping': 'audit.view',
  'POST /api/compliance/mapping/stamp': 'mapping.stamp',
  'POST /api/evidence/packs': 'evidence.generate',
  'GET /api/evidence/packs': 'audit.view',
  'GET /api/evidence/packs/:id': 'audit.view',
  'GET /api/evidence/packs/:id/download': 'audit.view',
  'GET /api/evidence/jobs/:id': 'audit.view',
  // intake portal and the operator's ticket views
  'GET /portal/api/limits': 'intake.submit',
  'POST /portal/api/intakes': 'intake.submit',
  'GET /portal/api/tickets': 'intake.view_own',
  'GET /portal/api/tickets/:id': 'intake.view_own',
  'POST /portal/api/tickets/:id/uat': 'uat.signoff_own',
  'GET /api/tickets': 'ticket.view_internal',
  'GET /api/tickets/:id': 'ticket.view_internal',
  'GET /api/tickets/:id/attachments/:attachmentId': 'user', // the ticket's own requester, or an operator with ticket.media_view
  'POST /api/tickets/:id/close': 'ticket.view_internal',
  'GET /api/tower': 'audit.view',
  // daemon
  'GET /api/health': 'public',
  'POST /api/admin/reactors/:name/redrive': 'ops.admin',
  'POST /api/admin/projections/rebuild': 'ops.admin',
  'POST /api/admin/jobs/:name/run': 'ops.admin',
  'GET /api/stream': 'session.view',
};

interface Principal {
  name: string;
  headers: Record<string, string>;
  kind: 'anon' | 'human' | 'ingest';
  role?: Role;
  complianceLead?: boolean;
}

function allowed(aud: Aud, p: Principal): boolean {
  if (aud === 'public') return true;
  if (aud === 'ingest') return p.kind === 'ingest';
  if (p.kind !== 'human') return false;
  if (aud === 'user') return true;
  return hasPermission(p.role!, aud, { complianceLead: p.complianceLead });
}

const fill = (path: string): string =>
  path
    .replace(':repo', 'prj_missing.git')
    .replace(':attachmentId', 'att_missing')
    .replace(':seq', '999999')
    .replace(':date', '2026-10-01')
    .replace(':field', 'impact')
    .replace(':name', 'x_missing')
    .replace(':id', 'x_missing');

const statusCell = (s: number): string => (s === 401 ? '.' : s === 403 ? 'x' : s >= 500 ? '!' : '+');

describe('authorization matrix (§3, §6, §7)', () => {
  let p: Prod;
  let principals: Principal[];
  let routes: { method: string; path: string; key: string }[];

  beforeAll(async () => {
    p = await bootProd();
    const requester = p.user('requester', 'Requester');
    const builder = p.user('builder', 'Builder');
    const lead = p.user('builder', 'Lead', { complianceLead: true });
    const approver = p.user('approver', 'Approver');
    const retired = p.user('builder', 'Left the team');
    identityServiceOf(p.aoc.runtime.services).revokeToken(retired.tokenId, 'test', { kind: 'system', id: 'test' });
    principals = [
      { name: 'anon', headers: {}, kind: 'anon' },
      { name: 'requester', headers: requester.headers, kind: 'human', role: 'requester' },
      { name: 'builder', headers: builder.headers, kind: 'human', role: 'builder' },
      { name: 'lead', headers: lead.headers, kind: 'human', role: 'builder', complianceLead: true },
      { name: 'approver', headers: approver.headers, kind: 'human', role: 'approver' },
      { name: 'observer', headers: p.ids.ingestHeaders('observer'), kind: 'ingest' },
      { name: 'session', headers: p.ids.ingestHeaders('ses_A'), kind: 'ingest' },
      { name: 'sidecar', headers: p.ids.sidecarHeaders('ses_A'), kind: 'ingest' },
      { name: 'system', headers: p.ids.ingestHeaders('system'), kind: 'ingest' },
      { name: 'revoked', headers: retired.headers, kind: 'anon' },
    ];
    routes = p.aoc.app.routes
      .filter((r) => r.method !== 'ALL' && r.path !== '/*')
      .map((r) => ({ method: r.method, path: r.path, key: `${r.method} ${r.path}` }));
  });
  afterAll(async () => p?.close());

  it('every registered route is classified, and every classified route exists', () => {
    const registered = new Set(routes.map((r) => r.key));
    expect(
      routes.filter((r) => !(r.key in ROUTES)).map((r) => r.key),
      'routes with no entry in ROUTES: decide who may call them',
    ).toEqual([]);
    expect(Object.keys(ROUTES).filter((k) => !registered.has(k)), 'ROUTES rows for routes that no longer exist').toEqual([]);
  });

  it('answers every principal on every route as intended, and never with a 5xx', async () => {
    const surprises: string[] = [];
    const grid: string[] = [];
    const heads = principals.map((x) => x.name.slice(0, 3));
    for (const r of routes) {
      const aud = ROUTES[r.key];
      if (aud === undefined) continue;
      let line = '';
      for (const who of principals) {
        const res = await p.request(r.method, fill(r.path), { headers: who.headers, body: r.method === 'GET' ? undefined : {} });
        if (r.path === '/api/stream') await res.body?.cancel();
        else await res.arrayBuffer();
        line += statusCell(res.status).padStart(4);
        const ok = allowed(aud, who);
        // Not authenticated at all is always 401; authenticated but not allowed is 403, decided before any lookup.
        // An ingest route only knows ingest tokens, so a person's token is "not authenticated" there; which ingest
        // token kinds a given tool accepts is checked with real bodies in the ingest tests below.
        const want = ok ? 'pass' : who.kind === 'human' && aud !== 'ingest' ? 403 : 401;
        const got = res.status === 401 || res.status === 403 ? res.status : 'pass';
        if (res.status >= 500) surprises.push(`${r.key} as ${who.name}: HTTP ${res.status}`);
        else if (aud === 'ingest' && who.kind === 'ingest') {
          if (res.status === 401) surprises.push(`${r.key} as ${who.name}: a valid ingest token was refused as unauthenticated`);
        } else if (got !== want) surprises.push(`${r.key} as ${who.name}: expected ${want}, got HTTP ${res.status}`);
      }
      grid.push(`${r.method.padEnd(6)} ${r.path.padEnd(46)}${line}   ${aud}`);
    }
    console.log(`authorization matrix (. 401, x 403, + passed, ! 5xx)\n${' '.repeat(53)}${heads.map((h) => h.padStart(4)).join('')}   audience\n${grid.join('\n')}`);
    expect(surprises).toEqual([]);
  });
});
