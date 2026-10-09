import { Fragment, useId } from 'react';
import { NavLink } from 'react-router-dom';
import { CountBadge } from '../components/Badge';
import { IconButton } from '../components/Button';
import { Icon } from '../components/Icon';
import { Tooltip } from '../components/Tooltip';
import { cx } from '../lib/dom';
import { NAV_GROUP_LABEL, type NavItem } from './navItems';

export interface SideNavProps {
  items: readonly NavItem[];
  /** Icon-only rail (desktop). Labels stay available to assistive tech and as tooltips. */
  collapsed?: boolean;
  /** Shows the collapse toggle (desktop rail only). */
  onToggleCollapsed?: () => void;
  /** Open decisions, echoed on the Decisions item. */
  inboxCount?: number | null;
  /** Called after a link is followed (closes the mobile drawer). */
  onNavigate?: () => void;
  id?: string;
  /** Landmark name. Only one nav is on screen at a time in the app; a page that shows several names each. */
  label?: string;
}

/** Consecutive items of the same group, in nav order. */
function sections(items: readonly NavItem[]): { group: NavItem['group']; items: NavItem[] }[] {
  const out: { group: NavItem['group']; items: NavItem[] }[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.group === it.group) last.items.push(it);
    else out.push({ group: it.group, items: [it] });
  }
  return out;
}

/**
 * Primary operator navigation: one list per group, named by its group label (a list may only contain list
 * items, so the labels and dividers sit between the lists). Active item gets `aria-current="page"` (NavLink).
 */
export function SideNav({
  items,
  collapsed = false,
  onToggleCollapsed,
  inboxCount,
  onNavigate,
  id,
  label = 'Primary',
}: SideNavProps) {
  const labelPrefix = useId();
  return (
    <nav id={id} className={cx('aoc-nav', collapsed && 'is-collapsed')} aria-label={label}>
      <div className="aoc-nav__list">
        {sections(items).map((section, si) => {
          const heading = NAV_GROUP_LABEL[section.group];
          const labelId = `${labelPrefix}-${section.group}`;
          const showHeading = Boolean(heading) && !collapsed;
          return (
            <Fragment key={section.group}>
              {si > 0 && !showHeading && <div className="aoc-nav__divider" aria-hidden="true" />}
              {showHeading && (
                <div className="aoc-nav__group" id={labelId}>
                  {heading}
                </div>
              )}
              <ul
                className="aoc-nav__items"
                aria-labelledby={showHeading ? labelId : undefined}
                aria-label={!showHeading ? heading : undefined}
              >
                {section.items.map((it) => {
                  const link = (
                    <NavLink
                      to={it.to}
                      className={({ isActive }) =>
                        cx('aoc-nav__link', isActive && 'is-active', it.deemphasised && 'is-quiet')
                      }
                      onClick={onNavigate}
                    >
                      <Icon name={it.icon} size={16} className="aoc-nav__icon" />
                      <span className="aoc-nav__label">{it.label}</span>
                      {it.to === '/decisions' && !collapsed && <CountBadge count={inboxCount} />}
                      {it.to === '/decisions' && collapsed && inboxCount ? (
                        <span className="aoc-nav__dot" aria-hidden="true" />
                      ) : null}
                    </NavLink>
                  );
                  return (
                    <li key={it.to}>{collapsed ? <Tooltip content={it.label}>{link}</Tooltip> : link}</li>
                  );
                })}
              </ul>
            </Fragment>
          );
        })}
      </div>
      {onToggleCollapsed && (
        <div className="aoc-nav__footer">
          <IconButton
            icon={collapsed ? 'sidebar-expand' : 'sidebar-collapse'}
            label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
            size="sm"
          />
        </div>
      )}
    </nav>
  );
}
