import { useEffect, useRef, useState } from 'react';
import type { AuditEventPageDTO, IdentityTokenDto, IdentityUserDto, Role } from '@aoc/contracts';
import { apiDelete, apiPatch, useResource } from '../../api';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Drawer,
  InlineAlert,
  RelativeTime,
  Select,
  describeError,
  formatDateTime,
  formatShortDate,
  useToast,
} from '../../components';
import { PasskeyList, RegisterPasskey } from './Passkeys';
import {
  REVOKE_REASON,
  ROLES_IN_ORDER,
  ROLE_META,
  isLastApprover,
  lastSeen,
  type UserFacts,
} from './model';

export interface UserDrawerProps {
  user: IdentityUserDto | null;
  users: readonly IdentityUserDto[];
  /** This person's user tokens and console sessions (any status). */
  tokens: readonly IdentityTokenDto[];
  facts?: UserFacts;
  lastSignInAt: string | null;
  isSelf: boolean;
  onClose: () => void;
  onIssueToken: (user: IdentityUserDto) => void;
  onChanged: () => void;
}

function TokenRow({ token, onRevoke }: { token: IdentityTokenDto; onRevoke: (t: IdentityTokenDto) => void }) {
  const live = token.status === 'active';
  return (
    <li className="admin-tokens__item">
      <code className="admin-tokens__prefix">{token.prefix}…</code>
      <div className="admin-tokens__main">
        <span>
          {token.kind === 'web_session' ? 'Console session' : (token.label ?? 'Personal token')}
        </span>
        <span className="admin-muted aoc-num">
          issued {formatShortDate(token.createdAt)}
          {live
            ? token.expiresAt
              ? ` · expires ${formatShortDate(token.expiresAt)}`
              : ' · no expiry'
            : token.status === 'expired'
              ? ' · expired'
              : ` · revoked${token.revokeReason ? ` (${REVOKE_REASON[token.revokeReason] ?? token.revokeReason})` : ''}`}
        </span>
      </div>
      {live ? (
        <Button size="sm" variant="ghost" onClick={() => onRevoke(token)}>
          {token.kind === 'web_session' ? 'Sign out…' : 'Revoke…'}
        </Button>
      ) : (
        <Badge tone="neutral">{token.status === 'expired' ? 'Expired' : 'Revoked'}</Badge>
      )}
    </li>
  );
}

/** One person's access: role and flags, activation, tokens (prefix only), passkeys and recent audited actions. */
export function UserDrawer({
  user,
  users,
  tokens,
  facts,
  lastSignInAt,
  isSelf,
  onClose,
  onIssueToken,
  onChanged,
}: UserDrawerProps) {
  const toast = useToast();
  const [role, setRole] = useState<Role>('builder');
  const [saving, setSaving] = useState<'role' | 'lead' | 'active' | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const [revokeTarget, setRevokeTarget] = useState<IdentityTokenDto | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<unknown>(undefined);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const keepActiveRef = useRef<HTMLButtonElement>(null);

  const userId = user?.id;
  const currentRole = user?.role;
  useEffect(() => {
    if (currentRole) setRole(currentRole);
    setError(undefined);
  }, [userId, currentRole]);

  const recent = useResource<AuditEventPageDTO>(userId ? '/api/audit/events' : null, {
    query: userId ? { actorId: userId, order: 'desc', limit: 6 } : undefined,
  });

  if (!user) return null;

  const lastApprover = isLastApprover(user, users);
  const demotionBlocked = lastApprover && role !== 'approver';
  const visibleTokens = tokens.filter((t) => t.kind === 'user' || t.status === 'active');

  const patch = async (what: 'role' | 'lead' | 'active', body: Record<string, unknown>, done: string) => {
    setSaving(what);
    setError(undefined);
    try {
      await apiPatch(`/api/users/${encodeURIComponent(user.id)}`, body);
      toast.notify({ tone: 'ok', title: done });
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(null);
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    setRevokeError(undefined);
    try {
      await apiDelete(`/api/tokens/${encodeURIComponent(revokeTarget.tokenId)}`);
      toast.notify({ tone: 'ok', title: `Token ${revokeTarget.prefix}… revoked` });
      setRevokeTarget(null);
      onChanged();
    } catch (err) {
      setRevokeError(err);
    } finally {
      setRevokeBusy(false);
    }
  };

  const seen = lastSeen(facts?.lastActionAt, lastSignInAt);

  return (
    <Drawer
      open
      onClose={onClose}
      title={user.name}
      description={user.email ?? undefined}
      width={520}
    >
      <div className="admin-drawer">
        <div className="admin-drawer__badges">
          <Badge tone={ROLE_META[user.role].tone}>{ROLE_META[user.role].label}</Badge>
          {user.flags.complianceLead && (
            <Badge tone="info" icon="compliance">
              Compliance lead
            </Badge>
          )}
          <Badge tone={user.active ? 'ok' : 'neutral'} icon={user.active ? 'ok' : 'minus'}>
            {user.active ? 'Active' : 'Inactive'}
          </Badge>
          {isSelf && <Badge tone="neutral">You</Badge>}
        </div>

        <section className="admin-drawer__section" aria-labelledby="admin-role-title">
          <h3 id="admin-role-title" className="admin-drawer__h">
            Role and access
          </h3>
          <div className="admin-role">
            <Select
              label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              options={ROLES_IN_ORDER.map((r) => ({ value: r, label: ROLE_META[r].label }))}
              hint={
                demotionBlocked
                  ? 'The last active Approver cannot be demoted: add or promote another Approver first.'
                  : ROLE_META[role].hint
              }
              fieldClassName="admin-role__field"
              disabled={!user.active}
            />
            <Button
              onClick={() => void patch('role', { role }, `${user.name} is now ${ROLE_META[role].label}`)}
              disabled={role === user.role || demotionBlocked || !user.active}
              loading={saving === 'role'}
              loadingText="Saving…"
            >
              Save role
            </Button>
          </div>
          <Checkbox
            label="Compliance lead"
            checked={user.flags.complianceLead}
            disabled={saving !== null || user.role === 'requester' || !user.active}
            onChange={(e) =>
              void patch(
                'lead',
                { flags: { complianceLead: e.target.checked } },
                e.target.checked ? `${user.name} is a compliance lead` : `${user.name} is no longer a compliance lead`,
              )
            }
            hint={
              user.role === 'requester'
                ? 'Requesters cannot stamp the compliance mapping.'
                : 'May stamp the ISO/IEC 42001 mapping as reviewed.'
            }
          />
          <div className="admin-drawer__row">
            {user.active ? (
              <>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setConfirmDeactivate(true)}
                  disabled={lastApprover || isSelf}
                >
                  Deactivate…
                </Button>
                <span className="admin-muted">
                  {lastApprover
                    ? 'The last active Approver cannot be deactivated.'
                    : isSelf
                      ? 'Ask another Approver to deactivate you.'
                      : 'Revokes every live token and console session.'}
                </span>
              </>
            ) : (
              <Button
                size="sm"
                onClick={() => void patch('active', { active: true }, `${user.name} reactivated`)}
                loading={saving === 'active'}
                loadingText="Reactivating…"
              >
                Reactivate
              </Button>
            )}
          </div>
          {error !== undefined && (
            <InlineAlert tone="danger" title="Not saved" live>
              {describeError(error)}
            </InlineAlert>
          )}
        </section>

        <section className="admin-drawer__section" aria-labelledby="admin-tokens-title">
          <div className="admin-drawer__head">
            <h3 id="admin-tokens-title" className="admin-drawer__h">
              Tokens
            </h3>
            {user.active && (
              <Button size="sm" icon="key" onClick={() => onIssueToken(user)}>
                Issue token
              </Button>
            )}
          </div>
          {visibleTokens.length === 0 ? (
            <p className="admin-muted">No tokens. Issue one so {user.name} can sign in.</p>
          ) : (
            <ul className="admin-tokens">
              {visibleTokens.map((t) => (
                <TokenRow key={t.tokenId} token={t} onRevoke={setRevokeTarget} />
              ))}
            </ul>
          )}
        </section>

        <section className="admin-drawer__section" aria-labelledby="admin-passkeys-title">
          <h3 id="admin-passkeys-title" className="admin-drawer__h">
            Passkeys
          </h3>
          {facts ? (
            <PasskeyList passkeys={facts.passkeys} owner={isSelf ? 'you' : user.name} onRemoved={onChanged} />
          ) : (
            <p className="admin-muted">Loading passkeys…</p>
          )}
          {isSelf ? (
            <RegisterPasskey onRegistered={onChanged} />
          ) : (
            <p className="admin-muted">Only {user.name} can register their own passkey, signed in as themselves.</p>
          )}
        </section>

        <section className="admin-drawer__section" aria-labelledby="admin-activity-title">
          <h3 id="admin-activity-title" className="admin-drawer__h">
            Activity
          </h3>
          <p className="admin-muted aoc-num">
            Last seen {seen ? <RelativeTime value={seen} suffix=" ago" /> : 'never'} · last console sign-in{' '}
            {lastSignInAt ? formatDateTime(lastSignInAt) : 'never'}
          </p>
          {recent.data && recent.data.events.length > 0 && (
            <ol className="admin-activity">
              {recent.data.events.map((e) => (
                <li key={e.seq} className="admin-activity__item">
                  <code>{e.type}</code>
                  <time className="admin-muted aoc-num" dateTime={e.ts}>
                    {formatDateTime(e.ts)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <Dialog
        open={revokeTarget !== null}
        onClose={() => {
          setRevokeTarget(null);
          setRevokeError(undefined);
        }}
        role="alertdialog"
        size="sm"
        title={revokeTarget?.kind === 'web_session' ? 'Sign out this console session?' : 'Revoke this token?'}
        description={
          revokeTarget?.kind === 'user'
            ? `${revokeTarget.prefix}… stops working at once, and so do the console sessions opened with it.`
            : 'That browser is signed out at its next request.'
        }
        initialFocus={keepRef}
        footer={
          <>
            <Button ref={keepRef} onClick={() => setRevokeTarget(null)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => void revoke()} loading={revokeBusy} loadingText="Revoking…">
              {revokeTarget?.kind === 'web_session' ? 'Sign out' : 'Revoke token'}
            </Button>
          </>
        }
      >
        {revokeError !== undefined && (
          <InlineAlert tone="danger" title="Not revoked" live>
            {describeError(revokeError)}
          </InlineAlert>
        )}
      </Dialog>

      <Dialog
        open={confirmDeactivate}
        onClose={() => setConfirmDeactivate(false)}
        role="alertdialog"
        size="sm"
        title={`Deactivate ${user.name}?`}
        description="Every live token and console session they hold is revoked. Reactivating later does not revive old tokens."
        initialFocus={keepActiveRef}
        footer={
          <>
            <Button ref={keepActiveRef} onClick={() => setConfirmDeactivate(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={saving === 'active'}
              loadingText="Deactivating…"
              onClick={() =>
                void patch('active', { active: false }, `${user.name} deactivated`).then(() =>
                  setConfirmDeactivate(false),
                )
              }
            >
              Deactivate
            </Button>
          </>
        }
      />
    </Drawer>
  );
}
