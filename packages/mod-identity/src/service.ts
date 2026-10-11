import {
  hasPermission,
  newId,
  PERMISSIONS,
  type Actor,
  type AuthContext,
  type AuthMeDto,
  type DirectoryDto,
  type IdentityService,
  type IdentityTokenDto,
  type IdentityTokenKind,
  type IdentityUserDto,
  type IngestPrincipal,
  type IssuedTokenDto,
  type PasskeyVerificationResult,
  type Permission,
  type Role,
  type User,
} from '@aoc/contracts';
import { HttpError, type ModuleContext, type NewEvent } from '@aoc/kernel';
import { PasskeyService, userBodyScope } from './passkeys';
import type { TokenRow, UserRow } from './projector';
import { digestsEqual, generateToken, hashToken, parseToken } from './tokens';

export const IDENTITY_SYSTEM_ACTOR: Actor = { kind: 'system', id: 'identity' };
export const TOKEN_SHOWN_ONCE_NOTE =
  'Store this token now: it is shown only once and cannot be recovered (only its hash is kept).';

const USER_KINDS: readonly IdentityTokenKind[] = ['user', 'web_session'];
const INGEST_KINDS: readonly IdentityTokenKind[] = ['ingest_session', 'ingest_sidecar', 'observer', 'system'];
const SESSION_TOKEN_KIND = { session: 'ingest_session', sidecar: 'ingest_sidecar' } as const;
const DAY_MS = 86_400_000;
const MAX_COOKIE_AGE_S = 400 * 86_400;

export type TokenCheckFailure =
  'malformed' | 'unknown' | 'wrong_kind' | 'revoked' | 'expired' | 'user_inactive';
export type TokenCheck =
  | { ok: true; row: TokenRow; user: User | null; prefix: string }
  | { ok: false; reason: TokenCheckFailure; prefix: string | null };

export interface CreateUserInput {
  role: Role;
  name?: string;
  email?: string | null;
  complianceLead?: boolean;
  id?: string;
}

export interface UpdateUserPatch {
  name?: string;
  email?: string | null;
  role?: Role;
  active?: boolean;
  complianceLead?: boolean;
}

export interface IssueTokenOptions {
  label?: string | null;
  expiresInDays?: number | null;
  /** Bring-your-own token (bootstrap from AOC_BOOTSTRAP_TOKEN); must match the kind's format. */
  token?: string;
}

export type WebSessionResult =
  | { ok: true; issued: IssuedTokenDto; auth: AuthContext; maxAgeSeconds: number }
  | { ok: false; reason: TokenCheckFailure; prefix: string | null };

/**
 * Persistent IdentityService (§6): users and roles, bearer/cookie/ingest tokens stored as sha256 only,
 * and WebAuthn passkeys. A drop-in superset of the kernel's DevIdentityService.
 */
export class IdentityServiceImpl implements IdentityService {
  readonly passkeys: PasskeyService;

  constructor(private readonly ctx: ModuleContext) {
    this.passkeys = new PasskeyService(ctx, this);
  }

  private now(): number {
    return this.ctx.clock.now();
  }

  // ── users ──────────────────────────────────────────────────────────────────
  private userRow(id: string): UserRow | null {
    return (
      (this.ctx.db.prepare('SELECT * FROM idn_users WHERE id = ?').get(id) as UserRow | undefined) ?? null
    );
  }

  getUser(id: string): User | null {
    const r = this.userRow(id);
    return r ? toUser(r) : null;
  }

  getUserDto(id: string): IdentityUserDto | null {
    const r = this.userRow(id);
    return r ? toUserDto(r) : null;
  }

  listUsers(): User[] {
    return this.userRows().map(toUser);
  }

  listUserDtos(): IdentityUserDto[] {
    return this.userRows().map(toUserDto);
  }

  /** Operator names for attribution on governance records; requesters stay behind the role boundary. */
  directory(): DirectoryDto {
    const people: DirectoryDto['people'] = [];
    for (const r of this.userRows()) {
      if (r.role === 'requester') continue;
      people.push({
        id: r.id,
        name: r.name,
        role: r.role,
        active: r.active === 1,
        complianceLead: r.compliance_lead === 1,
      });
    }
    return { people };
  }

  private userRows(): UserRow[] {
    return this.ctx.db.prepare('SELECT * FROM idn_users ORDER BY created_seq').all() as unknown as UserRow[];
  }

  /** Authoritative "has anyone ever been created" check: the log, not the (rebuildable) projection. */
  hasUserEvents(): boolean {
    return this.ctx.store.list({ types: ['user.created'], limit: 1 }).length > 0;
  }

  activeApproverCount(): number {
    return (
      this.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM idn_users WHERE role = 'approver' AND active = 1")
        .get() as { n: number }
    ).n;
  }

  can(user: User, perm: Permission): boolean {
    return user.active && hasPermission(user.role, perm, user.flags);
  }

  createUser(input: CreateUserInput, actor: Actor = IDENTITY_SYSTEM_ACTOR): User {
    const ev = this.userCreatedEvent(input, actor);
    this.ctx.store.append(ev);
    return this.getUser(ev.meta.userId)!;
  }

  /** Create a user and their first user token in one atomic append (bootstrap, admin tooling, tests). */
  createUserWithToken(
    input: CreateUserInput,
    tokenOpts: IssueTokenOptions,
    actor: Actor = IDENTITY_SYSTEM_ACTOR,
  ): { user: User; issued: IssuedTokenDto } {
    const userEv = this.userCreatedEvent(input, actor);
    const { event, issued } = this.tokenIssuedEvent(
      'user',
      { userId: userEv.meta.userId, ...tokenOpts },
      actor,
    );
    this.ctx.store.appendMany([userEv, event]);
    return { user: this.getUser(userEv.meta.userId)!, issued };
  }

  private userCreatedEvent(input: CreateUserInput, actor: Actor): NewEvent<'user.created'> {
    const id = input.id ?? newId('user', this.now());
    if (this.userRow(id)) throw new HttpError(409, 'user_exists', 'User already exists');
    const email = input.email ? input.email.trim().toLowerCase() : null;
    if (email) this.assertEmailFree(email, null);
    const name = input.name?.trim() || `${input.role} user`;
    return {
      type: 'user.created',
      actor,
      scope: { userId: id },
      meta: { userId: id, role: input.role, complianceLead: input.complianceLead ?? false },
      payload: email ? { name, email } : { name },
      source: sourceOf(actor),
      bodyScope: userBodyScope(id),
    };
  }

  private assertEmailFree(email: string, exceptUserId: string | null): void {
    const row = this.ctx.db
      .prepare('SELECT id FROM idn_users WHERE email = ? AND id IS NOT ?')
      .get(email, exceptUserId) as { id: string } | undefined;
    if (row) throw new HttpError(409, 'email_taken', 'Another user already has this email');
  }

  /**
   * Change role / active / flags / profile. The last active Approver can be neither demoted nor
   * deactivated (somebody must always hold the gates). Deactivation revokes every live user and cookie
   * token of the person, so reactivation never revives an old credential.
   */
  updateUser(id: string, patch: UpdateUserPatch, actor: Actor): User {
    const row = this.userRow(id);
    if (!row) throw new HttpError(404, 'user_not_found', 'User not found');
    const roleChange = patch.role !== undefined && patch.role !== row.role ? patch.role : null;
    const activeChange =
      patch.active !== undefined && patch.active !== (row.active === 1) ? patch.active : null;
    const leadChange =
      patch.complianceLead !== undefined && patch.complianceLead !== (row.compliance_lead === 1)
        ? patch.complianceLead
        : null;
    const losesApprover =
      row.active === 1 && row.role === 'approver' && (roleChange !== null || activeChange === false);
    if (losesApprover && this.activeApproverCount() <= 1) {
      throw new HttpError(409, 'last_approver', 'Cannot demote or deactivate the last active Approver');
    }
    const payload: { name?: string; email?: string | null } = {};
    const name = patch.name?.trim();
    if (name && name !== row.name) payload.name = name;
    if (patch.email !== undefined) {
      const email = patch.email ? patch.email.trim().toLowerCase() : null;
      if (email !== row.email) {
        if (email) this.assertEmailFree(email, id);
        payload.email = email;
      }
    }
    if (
      roleChange === null &&
      activeChange === null &&
      leadChange === null &&
      Object.keys(payload).length === 0
    )
      return toUser(row);
    const events: NewEvent[] = [
      {
        type: 'user.updated',
        actor,
        scope: { userId: id },
        meta: { userId: id, role: roleChange, active: activeChange, complianceLead: leadChange },
        payload,
        source: sourceOf(actor),
        bodyScope: userBodyScope(id),
      },
    ];
    if (activeChange === false) {
      for (const t of this.liveTokenRows('user_id = ?', id))
        events.push(this.revokedEvent(t, 'user_deactivated', actor));
    }
    this.ctx.store.appendMany(events);
    return this.getUser(id)!;
  }

  me(auth: AuthContext): AuthMeDto {
    const user = this.getUserDto(auth.user.id);
    if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in required');
    return {
      user,
      permissions: PERMISSIONS.filter((p) => this.can(auth.user, p)),
      method: auth.method,
      tokenId: auth.tokenId,
      hasPasskey: this.passkeys.hasPasskey(auth.user.id),
    };
  }

  // ── tokens ─────────────────────────────────────────────────────────────────
  private tokenIssuedEvent(
    kind: IdentityTokenKind,
    o: IssueTokenOptions & {
      userId?: string | null;
      sessionId?: string | null;
      parentTokenId?: string | null;
      expiresAt?: string | null;
    },
    actor: Actor,
  ): { event: NewEvent<'token.issued'>; issued: IssuedTokenDto } {
    const token = o.token ?? generateToken(kind);
    const parsed = parseToken(token);
    if (!parsed || parsed.kind !== kind)
      throw new HttpError(422, 'invalid_token_format', `Token does not match the ${kind} token format`);
    const tokenId = newId('token', this.now());
    const expiresAt =
      o.expiresAt ?? (o.expiresInDays ? new Date(this.now() + o.expiresInDays * DAY_MS).toISOString() : null);
    const userId = o.userId ?? null;
    const sessionId = o.sessionId ?? null;
    const label = o.label?.trim();
    const event: NewEvent<'token.issued'> = {
      type: 'token.issued',
      actor,
      scope: { ...(userId ? { userId } : {}), ...(sessionId ? { sessionId } : {}) },
      meta: {
        tokenId,
        userId,
        kind,
        sessionId,
        parentTokenId: o.parentTokenId ?? null,
        expiresAt,
        tokenHash: hashToken(token),
        tokenPrefix: parsed.prefix,
      },
      payload: label ? { label } : {},
      source: sourceOf(actor),
      bodyScope: userId ? userBodyScope(userId) : sessionId ? sessionId : 'identity',
    };
    return {
      event,
      issued: { token, tokenId, kind, prefix: parsed.prefix, expiresAt, note: TOKEN_SHOWN_ONCE_NOTE },
    };
  }

  private issue(
    kind: IdentityTokenKind,
    o: Parameters<IdentityServiceImpl['tokenIssuedEvent']>[1],
    actor: Actor,
  ): IssuedTokenDto {
    const { event, issued } = this.tokenIssuedEvent(kind, o, actor);
    this.ctx.store.append(event);
    return issued;
  }

  /** A personal API / login token for a user (`aoc_u_…`). The plaintext is returned once. */
  issueUserToken(userId: string, opts: IssueTokenOptions, actor: Actor): IssuedTokenDto {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user_not_found', 'User not found');
    if (!user.active) throw new HttpError(409, 'user_inactive', 'Cannot issue a token to an inactive user');
    return this.issue('user', { ...opts, userId }, actor);
  }

  /** Per-session ingest token (`aoc_i_…`): valid only for that session's /ingest writes. */
  issueIngestToken(sessionId: string, actor: Actor = IDENTITY_SYSTEM_ACTOR): string {
    return this.issue('ingest_session', { sessionId }, actor).token;
  }

  /**
   * Sidecar token (`aoc_c_…`) of one managed session: only the session's sidecar reports its heartbeats, activity,
   * usage, throttles and process exits. Never in the claude environment, unlike the session token (G-44).
   */
  issueSidecarToken(sessionId: string, actor: Actor = IDENTITY_SYSTEM_ACTOR): string {
    return this.issue('ingest_sidecar', { sessionId }, actor).token;
  }

  /** Observer token (`aoc_o_…`) for `aoc hooks install-observed`: observed, read-only sessions. */
  issueObserverToken(actor: Actor = IDENTITY_SYSTEM_ACTOR, opts: IssueTokenOptions = {}): string {
    return this.issueObserver(actor, opts).token;
  }

  /** An observer token for one developer (O-6): their observed sessions are attributed to them, and it dies with them. */
  issueObserver(actor: Actor, opts: IssueTokenOptions & { userId?: string } = {}): IssuedTokenDto {
    if (opts.userId !== undefined) {
      const user = this.getUser(opts.userId);
      if (!user) throw new HttpError(404, 'user_not_found', 'User not found');
      if (!user.active) throw new HttpError(409, 'user_inactive', 'Cannot issue a token to an inactive user');
    }
    return this.issue('observer', opts, actor);
  }

  /** System token (`aoc_s_…`) for trusted host components. */
  issueSystemToken(actor: Actor = IDENTITY_SYSTEM_ACTOR, opts: IssueTokenOptions = {}): string {
    return this.issue('system', opts, actor).token;
  }

  private tokenRow(id: string): TokenRow | null {
    return (
      (this.ctx.db.prepare('SELECT * FROM idn_tokens WHERE id = ?').get(id) as TokenRow | undefined) ?? null
    );
  }

  private liveTokenRows(where: string, ...args: string[]): TokenRow[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM idn_tokens WHERE revoked_at IS NULL AND ${where} ORDER BY created_at, id`)
      .all(...args) as unknown as TokenRow[];
    const now = this.now();
    return rows.filter((r) => !r.expires_at || Date.parse(r.expires_at) > now);
  }

  private revokedEvent(row: TokenRow, reason: string, actor: Actor): NewEvent<'token.revoked'> {
    return {
      type: 'token.revoked',
      actor,
      scope: {
        ...(row.user_id ? { userId: row.user_id } : {}),
        ...(row.session_id ? { sessionId: row.session_id } : {}),
      },
      meta: { tokenId: row.id, reason },
      source: sourceOf(actor),
    };
  }

  /**
   * Revoke a token; revoking a user token also ends the cookie sessions opened with it.
   * Returns the revoked token ids ([] if already revoked), or null if the token does not exist.
   */
  revokeToken(tokenId: string, reason: string, actor: Actor): string[] | null {
    const row = this.tokenRow(tokenId);
    if (!row) return null;
    if (row.revoked_at) return [];
    const events = [this.revokedEvent(row, reason, actor)];
    if (row.kind === 'user')
      for (const child of this.liveTokenRows('parent_id = ?', row.id))
        events.push(this.revokedEvent(child, 'parent_revoked', actor));
    this.ctx.store.appendMany(events);
    return events.map((e) => e.meta.tokenId);
  }

  revokeIngestTokensFor(
    sessionId: string,
    actor: Actor = IDENTITY_SYSTEM_ACTOR,
    kind?: 'session' | 'sidecar',
  ): void {
    const kinds = kind ? [SESSION_TOKEN_KIND[kind]] : Object.values(SESSION_TOKEN_KIND);
    const rows = this.liveTokenRows(
      `kind IN (${kinds.map(() => '?').join(', ')}) AND session_id = ?`,
      ...kinds,
      sessionId,
    );
    if (rows.length) this.ctx.store.appendMany(rows.map((r) => this.revokedEvent(r, 'session_ended', actor)));
  }

  getToken(tokenId: string): IdentityTokenDto | null {
    const row = this.tokenRow(tokenId);
    return row ? this.toTokenDto(row) : null;
  }

  listTokens(filter: { userId?: string; kind?: IdentityTokenKind } = {}): IdentityTokenDto[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.userId) (where.push('user_id = ?'), args.push(filter.userId));
    if (filter.kind) (where.push('kind = ?'), args.push(filter.kind));
    const sql = `SELECT * FROM idn_tokens ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`;
    return (this.ctx.db.prepare(sql).all(...args) as unknown as TokenRow[]).map((r) => this.toTokenDto(r));
  }

  private toTokenDto(r: TokenRow): IdentityTokenDto {
    const expired = r.expires_at !== null && Date.parse(r.expires_at) <= this.now();
    return {
      tokenId: r.id,
      kind: r.kind,
      prefix: r.prefix,
      userId: r.user_id,
      sessionId: r.session_id,
      parentTokenId: r.parent_id,
      label: r.label,
      createdAt: r.created_at,
      createdBy: r.created_by,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      revokeReason: r.revoke_reason,
      status: r.revoked_at ? 'revoked' : expired ? 'expired' : 'active',
    };
  }

  /**
   * Resolve a presented token. Candidates are looked up by their clear prefix and compared in constant
   * time against every candidate's stored sha256 (no early exit). "unknown" (no such token) is what
   * brute-force accounting counts; stale credentials (revoked/expired) are reported separately.
   */
  checkToken(token: string, kinds: readonly IdentityTokenKind[]): TokenCheck {
    const parsed = parseToken(token);
    if (!parsed) return { ok: false, reason: 'malformed', prefix: null };
    const digest = hashToken(token);
    const candidates = this.ctx.db
      .prepare('SELECT * FROM idn_tokens WHERE prefix = ?')
      .all(parsed.prefix) as unknown as TokenRow[];
    let row: TokenRow | null = null;
    for (const c of candidates) if (digestsEqual(digest, c.hash) && c.kind === parsed.kind) row = c;
    const prefix = parsed.prefix;
    if (!row) return { ok: false, reason: 'unknown', prefix };
    if (!kinds.includes(row.kind)) return { ok: false, reason: 'wrong_kind', prefix };
    if (row.revoked_at) return { ok: false, reason: 'revoked', prefix };
    if (row.expires_at && Date.parse(row.expires_at) <= this.now())
      return { ok: false, reason: 'expired', prefix };
    let user: User | null = null;
    if (row.user_id) {
      user = this.getUser(row.user_id);
      if (!user || !user.active) return { ok: false, reason: 'user_inactive', prefix };
    }
    return { ok: true, row, user, prefix };
  }

  checkUserCredential(token: string): TokenCheck {
    return this.checkToken(token, USER_KINDS);
  }

  checkIngestCredential(token: string): TokenCheck {
    return this.checkToken(token, INGEST_KINDS);
  }

  /** Bearer user tokens and cookie session tokens; never ingest/observer/system tokens. */
  authenticate(token: string): AuthContext | null {
    const r = this.checkUserCredential(token);
    if (!r.ok || !r.user) return null;
    return { user: r.user, tokenId: r.row.id, method: r.row.kind === 'web_session' ? 'cookie' : 'bearer' };
  }

  /** Ingest tokens only; user tokens never authenticate ingest writes. */
  verifyIngestToken(token: string): IngestPrincipal | null {
    const r = this.checkIngestCredential(token);
    if (!r.ok) return null;
    if (r.row.kind === 'ingest_session' || r.row.kind === 'ingest_sidecar') {
      const kind = r.row.kind === 'ingest_session' ? 'session' : 'sidecar';
      return r.row.session_id ? { kind, sessionId: r.row.session_id, tokenId: r.row.id } : null;
    }
    return r.row.kind === 'observer'
      ? { kind: 'observer', tokenId: r.row.id, userId: r.row.user_id ?? null }
      : { kind: 'system', tokenId: r.row.id };
  }

  /**
   * Exchange a user token for a separate random cookie-session token (`aoc_w_…`). The session expires
   * after sessionTtlHours, never later than the user token, and dies with it on revocation.
   */
  openWebSession(userToken: string): WebSessionResult {
    const r = this.checkToken(userToken, ['user']);
    if (!r.ok) return r;
    const user = r.user!;
    const now = this.now();
    let expiresAtMs = now + this.ctx.config.identity.sessionTtlHours * 3_600_000;
    if (r.row.expires_at) expiresAtMs = Math.min(expiresAtMs, Date.parse(r.row.expires_at));
    const issued = this.issue(
      'web_session',
      { userId: user.id, parentTokenId: r.row.id, expiresAt: new Date(expiresAtMs).toISOString() },
      { kind: 'human', id: user.id },
    );
    return {
      ok: true,
      issued,
      auth: { user, tokenId: issued.tokenId, method: 'cookie' },
      // Browsers cap cookie lifetimes at 400 days (and hono refuses longer Max-Age values).
      maxAgeSeconds: Math.min(MAX_COOKIE_AGE_S, Math.max(1, Math.floor((expiresAtMs - now) / 1000))),
    };
  }

  /** Logout: revoke a live cookie session token (no-op for anything else). */
  closeWebSession(sessionToken: string): boolean {
    const r = this.checkToken(sessionToken, ['web_session']);
    if (!r.ok) return false;
    this.revokeToken(r.row.id, 'logout', { kind: 'human', id: r.row.user_id! });
    return true;
  }

  // ── passkeys ───────────────────────────────────────────────────────────────
  /** Like verifyDecisionPasskey, with the failure reason the API can surface. */
  verifyDecisionPasskeyDetailed(input: {
    userId: string;
    decisionId: string;
    optionId: string;
    assertion: unknown;
  }): Promise<PasskeyVerificationResult> {
    return this.passkeys.verifyDecision(input);
  }

  async verifyDecisionPasskey(input: {
    userId: string;
    decisionId: string;
    optionId: string;
    assertion: unknown;
  }): Promise<boolean> {
    return (await this.passkeys.verifyDecision(input)).ok;
  }
}

function sourceOf(actor: Actor): 'api' | 'system' {
  return actor.kind === 'human' ? 'api' : 'system';
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    flags: { complianceLead: r.compliance_lead === 1 },
    active: r.active === 1,
  };
}

function toUserDto(r: UserRow): IdentityUserDto {
  return {
    ...toUser(r),
    flags: { complianceLead: r.compliance_lead === 1 },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
