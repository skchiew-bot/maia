import { Fragment } from 'react';
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
}

/** Primary operator navigation. Active item gets `aria-current="page"` (NavLink). */
export function SideNav({
  items,
  collapsed = false,
  onToggleCollapsed,
  inboxCount,
  onNavigate,
  id,
}: SideNavProps) {
  return (
    <nav id={id} className={cx('aoc-nav', collapsed && 'is-collapsed')} aria-label="Primary">
      <ul className="aoc-nav__list">
        {items.map((it, i) => {
          const prev = items[i - 1];
          const groupStart = !prev || prev.group !== it.group;
          const heading = groupStart ? NAV_GROUP_LABEL[it.group] : undefined;
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
            <Fragment key={it.to}>
              {groupStart && i > 0 && (!heading || collapsed) && (
                <li className="aoc-nav__divider" role="presentation" />
              )}
              {heading && !collapsed && (
                <li className="aoc-nav__group" role="presentation">
                  {heading}
                </li>
              )}
              <li>{collapsed ? <Tooltip content={it.label}>{link}</Tooltip> : link}</li>
            </Fragment>
          );
        })}
      </ul>
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
