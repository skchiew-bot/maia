import type { Permission } from '@aoc/contracts';
import type { AuthUser } from '../../api/auth';

/**
 * The governance permissions these pages hide or disable controls for (mirrors ROLE_PERMISSIONS in
 * @aoc/contracts roles.ts; the daemon still enforces every one). Requesters never reach operator pages.
 */
export type GovernancePermission = Extract<
  Permission,
  | 'change.create'
  | 'rollback.request'
  | 'breakglass.invoke'
  | 'promotion.request'
  | 'audit.view'
  | 'audit.verify'
  | 'audit.erase'
  | 'evidence.generate'
  | 'mapping.stamp'
  | 'gate.approve'
>;

const OPERATOR: ReadonlySet<GovernancePermission> = new Set([
  'change.create',
  'rollback.request',
  'breakglass.invoke',
  'promotion.request',
  'audit.view',
  'audit.verify',
  'evidence.generate',
]);
const APPROVER_ONLY: ReadonlySet<GovernancePermission> = new Set(['audit.erase', 'gate.approve']);

export function can(user: AuthUser | null | undefined, perm: GovernancePermission): boolean {
  if (!user || user.role === 'requester') return false;
  // mapping.stamp is never granted by role: only the compliance-lead flag stamps (R3).
  if (perm === 'mapping.stamp') return user.flags.complianceLead === true;
  if (APPROVER_ONLY.has(perm)) return user.role === 'approver';
  return OPERATOR.has(perm);
}
