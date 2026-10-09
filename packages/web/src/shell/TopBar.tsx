import { Link } from 'react-router-dom';
import { ROLE_LABEL, type AuthUser } from '../api/auth';
import type { ConnectionStatus } from '../api/stream';
import { CountBadge } from '../components/Badge';
import { IconButton } from '../components/Button';
import { Chip } from '../components/Chip';
import { Icon } from '../components/Icon';
import { Menu } from '../components/Menu';
import { cx } from '../lib/dom';

const CONNECTION: Record<ConnectionStatus, { word: string; tone: string }> = {
  live: { word: 'Live', tone: 'ok' },
  connecting: { word: 'Connecting…', tone: 'neutral' },
  reconnecting: { word: 'Reconnecting…', tone: 'warn' },
  offline: { word: 'Offline', tone: 'danger' },
};

/** "AOC" wordmark tile (brand red is reserved for the wordmark) + product name. */
export function ProductMark({ to = '/', name = 'Agent Ops Console' }: { to?: string; name?: string }) {
  return (
    <Link to={to} className="aoc-mark" aria-label={`AOC — ${name}, home`}>
      <span className="aoc-mark__tile" aria-hidden="true">
        AOC
      </span>
      <span className="aoc-mark__name">{name}</span>
    </Link>
  );
}

/** Live-stream state as a static word with a dot — it changes only when the connection does. */
export function ConnectionStatusIndicator({ status }: { status: ConnectionStatus }) {
  const c = CONNECTION[status];
  return (
    <span className={cx('aoc-conn', `aoc-conn--${c.tone}`)} role="status" title="Event stream connection">
      <span className="aoc-conn__dot" aria-hidden="true" />
      <span className="aoc-conn__word">{c.word}</span>
    </span>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

export interface UserMenuProps {
  user: AuthUser;
  onSignOut: () => void;
}

/** Avatar + name + role chip; the menu holds identity details and sign-out. */
export function UserMenu({ user, onSignOut }: UserMenuProps) {
  return (
    <Menu
      label={`Account: ${user.name}, ${ROLE_LABEL[user.role]}`}
      triggerClassName="aoc-user"
      trigger={
        <>
          <span className="aoc-user__avatar" aria-hidden="true">
            {initials(user.name)}
          </span>
          <span className="aoc-user__name">{user.name}</span>
          <Chip tone={user.role === 'approver' ? 'accent' : 'neutral'} className="aoc-user__role">
            {ROLE_LABEL[user.role]}
          </Chip>
          <Icon name="chevron-down" size={12} className="aoc-user__caret" />
        </>
      }
      header={
        <div className="aoc-user__card">
          <span className="aoc-user__card-name">{user.name}</span>
          <span className="aoc-user__card-meta">
            {ROLE_LABEL[user.role]} · <code>{user.id}</code>
          </span>
          <span className="aoc-user__card-note">
            Signed in with a bearer token — attribution, not a signed approval.
          </span>
        </div>
      }
      items={[{ id: 'sign-out', label: 'Sign out', icon: 'sign-out', onSelect: onSignOut }]}
    />
  );
}

export interface TopBarProps {
  /** Event-stream state ("Live" / "Reconnecting…"). */
  connection: ConnectionStatus;
  /** Open human-required decisions; `null` while unknown. */
  inboxCount: number | null;
  user: AuthUser;
  onSignOut: () => void;
  /** Opens the navigation drawer (phones). */
  onOpenNav: () => void;
  navOpen: boolean;
}

/** Compact operator top bar. Presentational — OperatorLayout wires the data. */
export function TopBar({ connection, inboxCount, user, onSignOut, onOpenNav, navOpen }: TopBarProps) {
  const open = inboxCount ?? 0;
  return (
    <header className="aoc-topbar">
      <IconButton
        icon="menu"
        label="Open navigation"
        className="aoc-topbar__menu"
        aria-expanded={navOpen}
        aria-controls="aoc-nav-drawer"
        onClick={onOpenNav}
        noTooltip
      />
      <ProductMark />
      <div className="aoc-topbar__spacer" />
      <ConnectionStatusIndicator status={connection} />
      <Link
        to="/decisions"
        className={cx('aoc-inbox', open > 0 && 'has-items')}
        aria-label={`Decisions inbox${inboxCount === null ? '' : `, ${open} open`}`}
      >
        <Icon name="inbox" size={16} />
        <span className="aoc-inbox__label">Decisions</span>
        <CountBadge count={inboxCount} />
      </Link>
      <UserMenu user={user} onSignOut={onSignOut} />
    </header>
  );
}
