import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { IdentityTokenDto, IdentityUserDto, Role } from '@aoc/contracts';
import { apiDelete, combine, useAuth, useResource, type StreamMessage } from '../../api';
import { SegmentBar } from '../../charts';
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  InlineAlert,
  KpiStrip,
  KpiTile,
  PageHeader,
  RelativeTime,
  ResourceView,
  Widget,
  WidgetGrid,
  describeError,
  formatInteger,
  formatShortDate,
  useToast,
  type DataTableColumn,
} from '../../components';
import { useSectionScroll } from '../../lib/sectionScroll';
import { CreateUserDialog } from './CreateUserDialog';
import { GateCoverage } from './GateCoverage';
import { AttributionNote, IssueTokenDialog, type TokenTarget } from './IssueTokenDialog';
import { PasskeyList, RegisterPasskey } from './Passkeys';
import { UserDrawer } from './UserDrawer';
import { useUserFacts } from './useUserFacts';
import {
  REVOKE_REASON,
  ROLE_META,
  activeApprovers,
  gateCoverage,
  hasUsablePasskey,
  isIdentityEvent,
  lastSeen,
  lastSignIns,
  liveBootstrapTokens,
  liveTokensOf,
  roleCounts,
  tokenHygiene,
} from './model';
import './admin.css';

const refreshOn = (m: StreamMessage) => m.kind === 'aoc' && isIdentityEvent(m.event.type);

function Skeleton({ height, label }: { height: number; label: string }) {
  return (
    <div className="admin-skel" style={{ height }} role="status">
      <span className="aoc-sr-only">{label}</span>
    </div>
  );
}

/**
 * Admin › Users (§6, Approver only — the route enforces it and so does the server): people and roles, who
 * holds which gate, tokens shown once then by prefix, passkeys for signed approvals, observer tokens.
 */
export default function AdminUsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const users = useResource<{ users: IdentityUserDto[] }>('/api/users', { refreshOn });
  const userTokens = useResource<{ tokens: IdentityTokenDto[] }>('/api/tokens', {
    query: { kind: 'user' },
    refreshOn,
  });
  const sessions = useResource<{ tokens: IdentityTokenDto[] }>('/api/tokens', {
    query: { kind: 'web_session' },
    refreshOn,
  });
  const observers = useResource<{ tokens: IdentityTokenDto[] }>('/api/tokens', {
    query: { kind: 'observer' },
    refreshOn,
  });
  const people = users.data?.users;
  const ids = useMemo(() => people?.map((u) => u.id), [people]);
  const facts = useUserFacts(ids);
  useSectionScroll(users, userTokens, sessions, observers, facts);

  const [createRole, setCreateRole] = useState<Role | null>(null);
  const [tokenTarget, setTokenTarget] = useState<TokenTarget | null>(null);
  const [revokeObserver, setRevokeObserver] = useState<IdentityTokenDto | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<unknown>(undefined);
  const keepRef = useRef<HTMLButtonElement>(null);

  const list = people ?? [];
  const signIns = useMemo(() => lastSignIns(sessions.data?.tokens ?? []), [sessions.data]);
  const gates = useMemo(() => gateCoverage(list, facts.data), [list, facts.data]);
  const counts = useMemo(() => roleCounts(list), [list]);
  const hygiene = useMemo(() => tokenHygiene(userTokens.data?.tokens ?? [], list), [userTokens.data, list]);
  const approvers = activeApprovers(list);
  const approversWithoutKey = facts.data ? approvers.filter((u) => !hasUsablePasskey(facts.data, u.id)) : [];
  const meHasKey = me ? hasUsablePasskey(facts.data, me.id) : false;
  const noLead =
    people !== undefined && !list.some((u) => u.active && u.flags.complianceLead && u.role !== 'requester');
  const liveObservers = (observers.data?.tokens ?? []).filter((t) => t.status === 'active');
  const bootstrap = liveBootstrapTokens(userTokens.data?.tokens ?? []);
  const openSessions = (sessions.data?.tokens ?? []).filter((t) => t.status === 'active').length;

  const openUserId = params.get('user');
  const openUser = openUserId ? (list.find((u) => u.id === openUserId) ?? null) : null;
  const setOpenUser = useCallback(
    (id: string | null) =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          if (id === null) next.delete('user');
          else next.set('user', id);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const reloadAll = () => {
    users.reload();
    userTokens.reload();
    sessions.reload();
    observers.reload();
    facts.reload();
  };

  const confirmRevokeObserver = async () => {
    if (!revokeObserver) return;
    setRevokeBusy(true);
    setRevokeError(undefined);
    try {
      await apiDelete(`/api/tokens/${encodeURIComponent(revokeObserver.tokenId)}`);
      toast.notify({ tone: 'ok', title: `Observer token ${revokeObserver.prefix}… revoked` });
      setRevokeObserver(null);
      observers.reload();
    } catch (err) {
      setRevokeError(err);
    } finally {
      setRevokeBusy(false);
    }
  };

  const columns = useMemo<DataTableColumn<IdentityUserDto>[]>(
    () => [
      {
        id: 'name',
        header: 'Person',
        primary: true,
        sortValue: (u) => u.name,
        cell: (u) => (
          <span className="admin-person">
            <span className="admin-person__name">
              {u.name}
              {u.id === me?.id && <span className="admin-person__you">you</span>}
            </span>
            {u.email && <span className="admin-muted">{u.email}</span>}
          </span>
        ),
      },
      {
        id: 'role',
        header: 'Role',
        sortValue: (u) => ['approver', 'builder', 'requester'].indexOf(u.role),
        sortLabels: ['Approvers first', 'Requesters first'],
        cell: (u) => <Badge tone={ROLE_META[u.role].tone}>{ROLE_META[u.role].label}</Badge>,
      },
      {
        id: 'lead',
        header: 'Compliance',
        sortValue: (u) => (u.flags.complianceLead ? 0 : 1),
        cell: (u) =>
          u.flags.complianceLead ? (
            <Badge tone="info" icon="compliance">
              Lead
            </Badge>
          ) : (
            <span className="admin-muted">—</span>
          ),
      },
      {
        id: 'passkeys',
        header: 'Passkeys',
        numeric: true,
        sortValue: (u) => facts.data?.get(u.id)?.passkeys.length ?? null,
        cell: (u) => {
          const n = facts.data?.get(u.id)?.passkeys.length;
          if (n === undefined) return <span className="admin-muted">…</span>;
          if (n === 0 && u.role === 'approver' && u.active)
            return (
              <span className="admin-warnword">
                <Icon name="warn" size={12} /> None
              </span>
            );
          return n === 0 ? <span className="admin-muted">None</span> : formatInteger(n);
        },
      },
      {
        id: 'tokens',
        header: 'Live tokens',
        numeric: true,
        sortValue: (u) => liveTokensOf(userTokens.data?.tokens ?? [], u.id).length,
        cell: (u) => {
          const live = liveTokensOf(userTokens.data?.tokens ?? [], u.id);
          return (
            <span className="admin-stack is-end">
              <span>{formatInteger(live.length)}</span>
              {live[0] && <code className="admin-prefix">{live[0].prefix}…</code>}
            </span>
          );
        },
      },
      {
        id: 'seen',
        header: 'Last seen',
        numeric: true,
        sortValue: (u) => lastSeen(facts.data?.get(u.id)?.lastActionAt, signIns.get(u.id)),
        cell: (u) => {
          const seen = lastSeen(facts.data?.get(u.id)?.lastActionAt, signIns.get(u.id));
          return seen ? (
            <RelativeTime value={seen} suffix=" ago" />
          ) : (
            <span className="admin-muted">never</span>
          );
        },
      },
      {
        id: 'status',
        header: 'Status',
        sortValue: (u) => (u.active ? 0 : 1),
        cell: (u) => (
          <Badge tone={u.active ? 'ok' : 'neutral'} icon={u.active ? 'ok' : 'minus'}>
            {u.active ? 'Active' : 'Inactive'}
          </Badge>
        ),
      },
      {
        id: 'manage',
        header: 'Manage',
        hideHeader: true,
        hideOnMobile: true,
        align: 'end',
        cell: (u) => (
          <Button size="sm" variant="ghost" onClick={() => setOpenUser(u.id)}>
            Manage
          </Button>
        ),
      },
    ],
    [facts.data, userTokens.data, signIns, me?.id, setOpenUser],
  );

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="People, roles, tokens and passkeys. Every change here is an audited event under your name."
        breadcrumbs={[{ label: 'Admin' }, { label: 'Users' }]}
        actions={
          <>
            <Button icon="key" onClick={() => setTokenTarget({ kind: 'observer' })}>
              Issue observer token
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setCreateRole('builder')}>
              Create user
            </Button>
          </>
        }
      />

      {people !== undefined && (
        <div className="admin-alerts">
          {approvers.length === 1 && (
            <InlineAlert
              tone="warn"
              title={`Only one Approver: ${approvers[0]!.name}`}
              action={
                <Button size="sm" onClick={() => setCreateRole('approver')}>
                  Add a deputy Approver
                </Button>
              }
            >
              Requests {approvers[0]!.id === me?.id ? 'you raise' : 'they raise'} can never be approved: a
              requester never resolves their own request, and the sole-Approver fallback is off. Add a deputy,
              or promote a Builder with Manage.
            </InlineAlert>
          )}
          {approvers.length === 0 && (
            <InlineAlert tone="danger" title="No active Approver">
              Nobody can approve gated work. Promote a Builder to Approver.
            </InlineAlert>
          )}
          {facts.data && approversWithoutKey.length > 0 && (
            <InlineAlert
              tone={approversWithoutKey.length === approvers.length ? 'danger' : 'warn'}
              title={
                approversWithoutKey.length === approvers.length
                  ? 'No Approver can sign go-live, rollback or break-glass'
                  : `${formatInteger(approversWithoutKey.length)} Approver${approversWithoutKey.length === 1 ? ' has' : 's have'} no passkey`
              }
              action={
                me && !meHasKey && me.role === 'approver' ? (
                  <a className="aoc-link-button" href="#your-passkeys">
                    Register yours
                  </a>
                ) : undefined
              }
            >
              {approversWithoutKey.map((u) => u.name).join(', ')}{' '}
              {approversWithoutKey.length === 1 ? 'needs' : 'need'} a registered passkey: those gates take a
              per-decision passkey assertion, not just a bearer token.
            </InlineAlert>
          )}
          {bootstrap.map((t) => (
            <InlineAlert
              key={t.tokenId}
              tone="warn"
              title="The setup token is still live"
              action={
                t.userId ? (
                  <Button size="sm" onClick={() => setOpenUser(t.userId)}>
                    Manage
                  </Button>
                ) : undefined
              }
            >
              <code>{t.prefix}…</code> was issued when AOC was first set up and never expires. Issue a
              personal token, sign in with it, then revoke this one (sessions opened with it end too).
            </InlineAlert>
          ))}
          {noLead && (
            <InlineAlert tone="info" title="No compliance lead">
              The ISO/IEC 42001 mapping stays provisional until a compliance lead stamps it. Set the flag with
              Manage.
            </InlineAlert>
          )}
        </div>
      )}

      <KpiStrip label="Identity at a glance">
        <KpiTile
          label="Active people"
          href="#people"
          value={people ? counts.approver + counts.builder + counts.requester : '—'}
          footnote={
            people
              ? `${formatInteger(counts.approver)} Approver${counts.approver === 1 ? '' : 's'} · ${formatInteger(
                  counts.builder,
                )} Builders · ${formatInteger(counts.requester)} Requesters`
              : undefined
          }
        />
        <KpiTile
          label="Approvers"
          href="#people"
          value={people ? counts.approver : '—'}
          tone={people && counts.approver < 2 ? (counts.approver === 0 ? 'danger' : 'warn') : 'neutral'}
          footnote={
            counts.approver < 2 ? 'add a deputy: own requests need a second Approver' : 'gates have cover'
          }
          info="With the sole-Approver fallback off, an Approver's own requests wait for another Approver."
        />
        <KpiTile
          label="Passkey coverage"
          href="#your-passkeys"
          value={
            facts.data
              ? `${formatInteger(approvers.length - approversWithoutKey.length)} of ${formatInteger(approvers.length)}`
              : '—'
          }
          unit="Approvers"
          tone={
            facts.data && approvers.length > 0 && approversWithoutKey.length === approvers.length
              ? 'danger'
              : approversWithoutKey.length > 0
                ? 'warn'
                : 'neutral'
          }
          footnote="needed for go-live, rollback, break-glass"
        />
        <KpiTile
          label="Live personal tokens"
          href="#people"
          value={userTokens.data ? hygiene.live : '—'}
          tone={hygiene.orphaned > 0 ? 'danger' : 'neutral'}
          footnote={
            userTokens.data
              ? `${formatInteger(hygiene.withoutExpiry)} without expiry · ${formatInteger(openSessions)} console session${
                  openSessions === 1 ? '' : 's'
                } open`
              : undefined
          }
          info="Bearer tokens are attribution, not signature: they prove which token was used, not who used it."
        />
        <KpiTile
          label="Observer tokens"
          href="#observer-tokens"
          value={observers.data ? liveObservers.length : '—'}
          footnote="for read-only observed sessions"
        />
      </KpiStrip>

      <WidgetGrid>
        <Widget
          span={7}
          title="Who holds the gates"
          subtitle="People able to clear each kind of gate right now"
          info="Approver gates route to active Approvers; passkey gates also need a registered passkey. One holder means no cover, and their own requests cannot be approved."
        >
          {people === undefined && !users.error ? (
            <Skeleton height={220} label="Loading gate coverage" />
          ) : (
            <ResourceView resource={users} isEmpty={() => false} errorTitle="Couldn't load users">
              {() => <GateCoverage gates={gates} />}
            </ResourceView>
          )}
        </Widget>

        <Widget span={5} title="Roles and credentials" subtitle="Active people by role · token hygiene">
          {people === undefined && !users.error ? (
            <Skeleton height={220} label="Loading roles" />
          ) : (
            <ResourceView
              resource={combine(users, userTokens)}
              isEmpty={() => false}
              errorTitle="Couldn't load users"
            >
              {() => (
                <div className="admin-mix">
                  <SegmentBar
                    label="Active people by role"
                    segments={[
                      { id: 'approver', label: 'Approvers', value: counts.approver, tone: 'series-1' },
                      { id: 'builder', label: 'Builders', value: counts.builder, tone: 'series-2' },
                      { id: 'requester', label: 'Requesters', value: counts.requester, tone: 'series-4' },
                    ]}
                    format={(v) => formatInteger(v)}
                  />
                  <dl className="admin-hygiene">
                    <div>
                      <dt>Live personal tokens</dt>
                      <dd className="aoc-num">{formatInteger(hygiene.live)}</dd>
                    </div>
                    <div className={hygiene.withoutExpiry > 0 ? 'is-warn' : undefined}>
                      <dt>{hygiene.withoutExpiry > 0 && <Icon name="warn" size={12} />} Without expiry</dt>
                      <dd className="aoc-num">{formatInteger(hygiene.withoutExpiry)}</dd>
                    </div>
                    <div className={hygiene.orphaned > 0 ? 'is-danger' : undefined}>
                      <dt>Held by inactive people</dt>
                      <dd className="aoc-num">{formatInteger(hygiene.orphaned)}</dd>
                    </div>
                    <div>
                      <dt>Console sessions open</dt>
                      <dd className="aoc-num">{formatInteger(openSessions)}</dd>
                    </div>
                  </dl>
                  <AttributionNote />
                </div>
              )}
            </ResourceView>
          )}
        </Widget>

        <Widget
          span={12}
          id="people"
          title="People"
          subtitle="Role, flags, passkeys, tokens and when each person was last seen"
          flush
        >
          {people === undefined && !users.error ? (
            <Skeleton height={240} label="Loading people" />
          ) : (
            <ResourceView resource={users} isEmpty={() => false} errorTitle="Couldn't load users">
              {() => (
                <div className="admin-flush">
                  <DataTable
                    caption="People and their access"
                    columns={columns}
                    rows={list}
                    rowKey={(u) => u.id}
                    defaultSort={{ columnId: 'role', direction: 'asc' }}
                    onRowClick={(u) => setOpenUser(u.id)}
                    rowLabel={(u) => `Manage ${u.name}`}
                    activeRowKey={openUserId ?? undefined}
                    rowTone={(u) =>
                      u.active && u.role === 'approver' && facts.data && !hasUsablePasskey(facts.data, u.id)
                        ? 'warn'
                        : undefined
                    }
                    busy={users.loading}
                    empty={<EmptyState size="sm" title="No users yet" />}
                  />
                </div>
              )}
            </ResourceView>
          )}
        </Widget>

        <Widget
          span={6}
          id="your-passkeys"
          title="Your passkeys"
          subtitle="Per-decision signatures for go-live, rollback and break-glass"
          info="A passkey assertion binds your approval to the exact decision and option you saw: signed approval, not just attribution."
        >
          {me && facts.data ? (
            <div className="admin-own-keys">
              <PasskeyList
                passkeys={facts.data.get(me.id)?.passkeys ?? []}
                owner="you"
                onRemoved={facts.reload}
              />
              <RegisterPasskey onRegistered={facts.reload} />
            </div>
          ) : facts.error ? (
            <ResourceView resource={facts} isEmpty={() => false} errorTitle="Couldn't load passkeys">
              {() => null}
            </ResourceView>
          ) : (
            <Skeleton height={120} label="Loading your passkeys" />
          )}
        </Widget>

        <Widget
          span={6}
          id="observer-tokens"
          title="Observer tokens"
          subtitle="Read-only observed sessions on developer hosts"
          actions={
            <Button size="sm" icon="key" onClick={() => setTokenTarget({ kind: 'observer' })}>
              Issue
            </Button>
          }
        >
          {observers.data === undefined && !observers.error ? (
            <Skeleton height={120} label="Loading observer tokens" />
          ) : (
            <ResourceView
              resource={observers}
              isEmpty={(d) => d.tokens.length === 0}
              empty={
                <EmptyState
                  size="sm"
                  icon="key"
                  title="No observer tokens"
                  body="Issue one per developer host for aoc hooks install-observed. They never authenticate the console."
                />
              }
              errorTitle="Couldn't load observer tokens"
            >
              {(d) => (
                <ul className="admin-tokens">
                  {d.tokens.map((t) => (
                    <li key={t.tokenId} className="admin-tokens__item">
                      <code className="admin-tokens__prefix">{t.prefix}…</code>
                      <div className="admin-tokens__main">
                        <span>{t.label ?? 'Observer token'}</span>
                        <span className="admin-muted aoc-num">
                          issued {formatShortDate(t.createdAt)}
                          {t.status === 'active'
                            ? t.expiresAt
                              ? ` · expires ${formatShortDate(t.expiresAt)}`
                              : ' · no expiry'
                            : t.status === 'expired'
                              ? ' · expired'
                              : ` · revoked${t.revokeReason ? ` (${REVOKE_REASON[t.revokeReason] ?? t.revokeReason})` : ''}`}
                        </span>
                      </div>
                      {t.status === 'active' ? (
                        <Button size="sm" variant="ghost" onClick={() => setRevokeObserver(t)}>
                          Revoke…
                        </Button>
                      ) : (
                        <Badge tone="neutral">{t.status === 'expired' ? 'Expired' : 'Revoked'}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </ResourceView>
          )}
        </Widget>
      </WidgetGrid>

      <UserDrawer
        user={openUser}
        users={list}
        tokens={[...(userTokens.data?.tokens ?? []), ...(sessions.data?.tokens ?? [])].filter(
          (t) => t.userId === openUser?.id,
        )}
        facts={openUser ? facts.data?.get(openUser.id) : undefined}
        lastSignInAt={openUser ? (signIns.get(openUser.id) ?? null) : null}
        isSelf={openUser?.id === me?.id}
        onClose={() => setOpenUser(null)}
        onIssueToken={(u) => setTokenTarget({ kind: 'user', user: u })}
        onChanged={reloadAll}
      />

      <CreateUserDialog
        open={createRole !== null}
        initialRole={createRole ?? 'builder'}
        onClose={() => setCreateRole(null)}
        onCreated={(u) => {
          setCreateRole(null);
          users.reload();
          toast.notify({
            tone: 'ok',
            title: `${u.name} created as ${ROLE_META[u.role].label}`,
            body: 'Issue a token so they can sign in.',
            action: { label: 'Issue token', onClick: () => setTokenTarget({ kind: 'user', user: u }) },
          });
        }}
      />

      <IssueTokenDialog
        target={tokenTarget}
        onClose={() => setTokenTarget(null)}
        onIssued={() => {
          userTokens.reload();
          observers.reload();
        }}
      />

      <Dialog
        open={revokeObserver !== null}
        onClose={() => {
          setRevokeObserver(null);
          setRevokeError(undefined);
        }}
        role="alertdialog"
        size="sm"
        title="Revoke this observer token?"
        description={
          revokeObserver
            ? `${revokeObserver.prefix}… stops working at once: hooks on that host buffer locally until they get a new token.`
            : undefined
        }
        initialFocus={keepRef}
        footer={
          <>
            <Button ref={keepRef} onClick={() => setRevokeObserver(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() => void confirmRevokeObserver()}
              loading={revokeBusy}
              loadingText="Revoking…"
            >
              Revoke token
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
    </>
  );
}
