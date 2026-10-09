/** Three-role access model (§6). One engine, one audit log; per-person identity underneath. */
import type { Role } from './domain';

export const PERMISSIONS = [
  'session.view', // see all sessions (transparent team console)
  'session.launch',
  'session.drive_own', // prompt / nudge / restart / stop own sessions
  'session.drive_any',
  'audit.view', // full audit trail
  'audit.verify',
  'audit.backup', // run an encrypted backup of the audit state on demand (Approver only, like audit.erase)
  'audit.erase', // crypto-shred a scope (PDPA)
  'decision.view',
  'decision.resolve', // subject to per-kind policy (decisions.ts)
  'change.create',
  'change.self_approve_reversible',
  'gate.approve', // fix-plan, go-live, rollback, playbook, break-glass, lesson binding, fx discrepancy
  'credit.view_all',
  'credit.topup_request',
  'credit.topup_approve',
  'credit.allocate',
  'ratecard.edit',
  'registry.view',
  'learning.view',
  'learning.curate', // assign root causes, propose lessons
  'evidence.generate',
  'mapping.stamp', // also requires the complianceLead flag
  'breakglass.invoke',
  'rollback.request',
  'promotion.request',
  'ticket.view_internal',
  'ticket.close_own', // close a ticket whose linked work (a session on it) the user owns; never as "withdrawn"
  'ticket.close_any',
  'ticket.media_view', // raw intake media (only when the work needs it)
  'intake.submit',
  'intake.view_own',
  'uat.signoff_own',
  'users.manage',
  'project.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const BUILDER: Permission[] = [
  'session.view',
  'session.launch',
  'session.drive_own',
  'audit.view',
  'audit.verify',
  'decision.view',
  'decision.resolve',
  'change.create',
  'change.self_approve_reversible',
  'credit.topup_request',
  'registry.view',
  'learning.view',
  'learning.curate',
  'evidence.generate',
  'breakglass.invoke',
  'rollback.request',
  'promotion.request',
  'ticket.view_internal',
  'ticket.close_own',
  'project.manage',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  // mapping.stamp is never granted by role: only the compliance-lead flag can stamp (R3).
  approver: new Set<Permission>(PERMISSIONS.filter((p) => p !== 'uat.signoff_own' && p !== 'mapping.stamp')),
  builder: new Set<Permission>(BUILDER),
  requester: new Set<Permission>(['intake.submit', 'intake.view_own', 'uat.signoff_own']),
};

export interface UserFlags {
  complianceLead?: boolean;
}

export function hasPermission(role: Role, perm: Permission, flags: UserFlags = {}): boolean {
  if (perm === 'mapping.stamp') return flags.complianceLead === true && role !== 'requester';
  return ROLE_PERMISSIONS[role].has(perm);
}
