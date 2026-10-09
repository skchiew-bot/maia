import type { Role } from '../api/auth';
import type { IconName } from '../components/Icon';

export type NavGroup = 'operate' | 'measure' | 'learn' | 'govern' | 'extras';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  group: NavGroup;
  /** Roles that see the item; omitted = every operator role. */
  roles?: readonly Role[];
  /** Rendered quieter and last (Showcase is optional and never the landing view, §12). */
  deemphasised?: boolean;
}

export const NAV_GROUP_LABEL: Record<NavGroup, string | undefined> = {
  operate: 'Operate',
  measure: 'Measure',
  learn: 'Learn',
  govern: 'Govern',
  extras: undefined,
};

/** Operator navigation, in the order of the console's information architecture. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/tower', label: 'Control Tower', icon: 'tower', group: 'operate' },
  { to: '/console', label: 'Console', icon: 'console', group: 'operate' },
  { to: '/projects', label: 'Projects', icon: 'projects', group: 'operate' },
  { to: '/decisions', label: 'Decisions', icon: 'decisions', group: 'operate' },
  { to: '/changes', label: 'Changes', icon: 'changes', group: 'operate' },
  { to: '/rollbacks', label: 'Rollbacks', icon: 'rollbacks', group: 'operate' },
  { to: '/registry', label: 'Registry', icon: 'registry', group: 'measure' },
  { to: '/metering', label: 'Metering', icon: 'metering', group: 'measure' },
  { to: '/credits', label: 'Credits', icon: 'credits', group: 'measure' },
  { to: '/learning', label: 'Learning', icon: 'learning', group: 'learn' },
  { to: '/knowledge', label: 'Knowledge', icon: 'knowledge', group: 'learn' },
  { to: '/audit', label: 'Audit', icon: 'audit', group: 'govern' },
  { to: '/compliance', label: 'Compliance', icon: 'compliance', group: 'govern' },
  { to: '/tickets', label: 'Tickets', icon: 'tickets', group: 'govern' },
  { to: '/admin/users', label: 'Admin', icon: 'admin', group: 'govern', roles: ['approver'] },
  { to: '/showcase', label: 'Showcase', icon: 'showcase', group: 'extras', deemphasised: true },
];

/** Items visible to a role, preserving order. */
export function navItemsFor(role: Role | undefined): NavItem[] {
  return NAV_ITEMS.filter((it) => !it.roles || (role !== undefined && it.roles.includes(role)));
}
