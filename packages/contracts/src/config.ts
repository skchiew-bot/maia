/** aocd configuration. `AocConfigSchema.parse({})` yields a complete, safe local default. */
import { z } from 'zod';
import { FX_SESSIONS } from './events/fx';

const thresholds = z
  .object({
    workingWindowMs: z.number().int().positive().default(30_000),
    stallAfterMs: z.number().int().positive().default(600_000),
    toolStallAfterMs: z.number().int().positive().default(1_200_000),
    deadAfterMs: z.number().int().positive().default(45_000),
  })
  .default({});

/** HH:MM, 24-hour, zero-padded (daily jobs compare it as a string with the local time in `timezone`). */
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const localTime = z.string().regex(LOCAL_TIME, 'expected HH:MM (24-hour local time)');

/**
 * Tier 1 of the self-modification boundary (docs/compliance/self-modification-boundary.md §1): the code and
 * configuration that decide who may approve what, what is recorded and what is charged, plus the build,
 * dependency and rule files that can change any of them. Relative to an AOC repo root; no `./` prefix.
 */
export const DEFAULT_PROTECTED_PATHS = [
  'packages/kernel/',
  'packages/contracts/',
  'packages/mod-audit/',
  'packages/mod-credits/',
  'packages/mod-decisions/',
  'packages/mod-identity/',
  'packages/hooks/',
  'config/',
  'packages/supervisor/',
  'packages/mod-change/',
  'packages/mod-sessions/',
  'packages/mod-ledger/',
  'packages/mod-metering/',
  'packages/mod-registry/',
  'packages/distill/',
  'packages/mod-evidence/',
  'packages/daemon/',
  'packages/client/',
  'packages/mcp-server/',
  'packages/sidecar/',
  'package.json',
  'packages/*/package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/',
  '.github/',
  'CLAUDE.md',
  'docs/spec/',
  'docs/compliance/',
] as const;

export const AocConfigSchema = z.object({
  /**
   * 'production' turns binding controls into startup refusals and withdraws development conveniences:
   * - managed sessions must run isolated from aocd (supervisor.isolation 'user', a separate read-only session user);
   * - the KEK must come from an existing keys.masterKeyFile outside dataDir (mode 0400/0600, owned by aocd's user) —
   *   never AOC_MASTER_KEY, never generated (docs/runbooks/credential-isolation.md §4, key-custody.md §3);
   * - with intake.requireScan, only an anti-virus engine counts as a scan (the builtin heuristic does not).
   */
  mode: z.enum(['development', 'production']).default('development'),
  /** Where aoc.db, bodies.db, keys, spool and artifacts live. */
  dataDir: z.string().default('.aoc/data'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(7420),
  /** Public origin for links / WebAuthn (must match the browser origin). */
  publicUrl: z.string().default('http://localhost:7420'),
  timezone: z.string().default('Asia/Kuala_Lumpur'),
  keys: z
    .object({
      /** 32-byte KEK (hex or base64) wrapping per-scope body keys. Generated (0600) in dataDir when absent — see docs/runbooks/key-custody.md. */
      masterKeyFile: z.string().optional(),
    })
    .default({}),
  liveness: thresholds,
  registryFile: z.string().default('config/process-types.json'),
  supervisor: z
    .object({
      claudeBin: z.string().default('claude'),
      /** Extra args prepended to every launch (e.g. for claude-sim: ["--import","tsx","…/cli.ts"] with claudeBin=node). */
      claudeArgsPrefix: z.array(z.string()).default([]),
      /** Commands for the per-session helpers (bundled JS paths are resolved by the daemon at startup). */
      sidecarCommand: z.array(z.string()).default([]),
      hookCommand: z.array(z.string()).default([]),
      mcpCommand: z.array(z.string()).default([]),
      workspacesDir: z.string().default('.aoc/workspaces'),
      maxConcurrentSessions: z.number().int().positive().default(8),
      /** Times the supervisor auto-continues a session that ended its turn with work left before asking a human. */
      autoContinueLimit: z.number().int().min(0).default(1),
      /** Env vars copied from aocd into sessions (everything else is dropped — credential isolation, §3). */
      envAllowlist: z.array(z.string()).default(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'TMPDIR', 'SHELL', 'USER', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']),
      /**
       * JSON file `{ profiles: { [name]: { env, files?, push?: { refs }, session?: { env, files? } } } }` readable
       * only by aocd's user. `env`/`files` are the credential, held by aocd alone (R-02): the push gateway forwards
       * a session's pushes with it, to the branches `push.refs` allows; a session never receives it. `session` is what
       * the session itself gets (model-visible: never a key that can push). A file is named by an env value as
       * `{{file:<name>}}`; a session's `session.files` come as private per-turn copies (deleted when the turn ends).
       */
      credentialProfilesFile: z.string().optional(),
      /**
       * How managed sessions are kept apart from aocd (§3, threat model O-1). 'user': every turn — claude, its hooks,
       * its MCP server and the model's tools — runs as `sessionUser` (`readOnlySessionUser` for read-only types),
       * with a per-session HOME, CLAUDE_CONFIG_DIR and TMPDIR, so it cannot read aocd's keys, databases or credential
       * profiles; aocd must run as root to switch users. 'none': sessions run as aocd's own user and can read all
       * of that — development only, warned on every launch. Unset: 'user' when sessionUser is set or in production
       * mode, else 'none'. Resolve it with `sessionIsolationOf(config)`.
       */
      isolation: z.enum(['none', 'user']).optional(),
      /** Unprivileged OS user for credentialed sessions (e.g. aoc-agent). Never root, never aocd's own user. */
      sessionUser: z.string().min(1).optional(),
      /**
       * OS user for read-only sessions (e.g. aoc-reader), with its own uid and primary group, so a triage session
       * can neither open a build session's key copy nor read its environment through /proc. Defaults to
       * sessionUser (warned); production requires a distinct user.
       */
      readOnlySessionUser: z.string().min(1).optional(),
      /**
       * Optional argv prefix that starts each turn in its isolated context instead of a direct uid/gid switch,
       * e.g. a per-session container wrapper or ["setpriv","--reuid={uid}","--regid={gid}","--clear-groups","--"].
       * Placeholders: {user} {uid} {gid} {sessionId} {sessionDir} {cwd}. It must run the command as that uid
       * with the environment it is given (verified at startup).
       */
      runner: z.array(z.string()).default([]),
      /** Per-session HOME, CLAUDE_CONFIG_DIR, TMPDIR and key copies (isolation 'user'); session users traverse it. */
      sessionHomesDir: z.string().default('.aoc/session-homes'),
    })
    .default({}),
  decisions: z
    .object({
      /** Opt-in webhook for new/aging decisions (R15). */
      webhookUrl: z.string().url().optional(),
      remindAfterMinutes: z.number().int().positive().default(30),
      /**
       * Let the only active Approver resolve their own requests (recorded selfApproved). Off by CEO decision
       * (2026-10-09): with one Approver, their own requests wait for a second Approver (separation of duties, §6).
       */
      soleApproverFallback: z.boolean().default(false),
    })
    .default({}),
  credits: z
    .object({
      defaultMonthlyAllocationUsd: z.number().min(0).default(300),
      autoGrantPct: z.number().min(0).max(100).default(25),
      /** Users exempt from caps (e.g. the Approver). */
      exemptUserIds: z.array(z.string()).default([]),
    })
    .default({}),
  metering: z
    .object({
      rateCardFile: z.string().default('config/rate-card.json'),
      closeDayAfterLocalTime: z.string().default('00:15'),
    })
    .default({}),
  fx: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * BNM session recorded as each day's USD/MYR rate (Kuala Lumpur interbank middle rate, RM per 1 USD), stamped on
       * every record. 1700 is the page's default view: scraped, then cross-checked with the BNM Open API. 0900 and
       * 1200 need a form POST on the page, so their figure comes from the API alone (extractor `api`).
       */
      session: z.enum(FX_SESSIONS).default('1700'),
      /** First attempt each day. BNM publishes a session about 40 minutes after its time (1700 → about 17:40). */
      runAtLocalTime: localTime.default('18:00'),
      /** Later attempts while the day's rate is not yet published or the source was unreadable; the last one decides. */
      retryAtLocalTimes: z.array(localTime).default(['18:30', '21:00']),
      /**
       * The day's first run re-checks the previous weekday when it was carried forward unread (a holiday stamp or an
       * unreadable source): if BNM has since published it, that day is attempted again; a day metering has closed is
       * never restated, so its late figure is only reported.
       */
      recheckPreviousWeekday: z.boolean().default(true),
      pageUrl: z.string().default('https://www.bnm.gov.my/exchange-rates'),
      /** BNM Open API USD endpoint: aocd requests `<apiUrl>/date/<YYYY-MM-DD>?session=<session>`. */
      apiUrl: z.string().url().default('https://api.bnm.gov.my/public/exchange-rate/USD'),
      extractor: z.enum(['claude-cli', 'anthropic-sdk', 'fake']).default('claude-cli'),
      sanity: z
        .object({
          min: z.number().default(3.5),
          max: z.number().default(5.5),
          /** Day-over-day move (%) rejected outright. */
          maxDailyChangePct: z.number().default(3),
          /** Day-over-day move (%) above which a scraped rate is accepted only if the API agrees exactly at 4 dp. */
          softFlagPct: z.number().default(1.25),
        })
        .default({}),
      /** Largest accepted difference between the scraped and the API rate, both rounded to 4 dp. */
      reconcileTolerance: z.number().min(0).default(0.0001),
      /** Weekdays in a row without a live rate (holidays count, weekends do not) before a manual check is requested. */
      carryForwardAlertWeekdays: z.number().int().positive().default(3),
    })
    .superRefine((fx, ctx) => {
      if (![fx.runAtLocalTime, ...fx.retryAtLocalTimes].every((t) => LOCAL_TIME.test(t))) return;
      const sessionTime = `${fx.session.slice(0, 2)}:${fx.session.slice(2)}`;
      if (fx.runAtLocalTime <= sessionTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runAtLocalTime'],
          message: `must be after the ${fx.session} session (BNM publishes it about 40 minutes later)`,
        });
      }
      fx.retryAtLocalTimes.forEach((time, i) => {
        const before = i === 0 ? fx.runAtLocalTime : fx.retryAtLocalTimes[i - 1]!;
        if (time <= before) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['retryAtLocalTimes', i],
            message: `must be later than ${before} (after runAtLocalTime, ascending)`,
          });
        }
      });
    })
    .default({}),
  audit: z
    .object({
      anchorProvider: z.enum(['git', 'rfc3161', 'none']).default('git'),
      /** Separate repo (ideally pushed off-host) that receives one signed commit per anchor. */
      anchorRepoPath: z.string().default('.aoc/anchor-repo'),
      anchorRemote: z.string().optional(),
      tsaUrl: z.string().default('https://freetsa.org/tsr'),
      anchorAtLocalTime: z.string().default('02:00'),
      /** OpenPGP key (id or fingerprint) that signs git anchor commits; Verify then requires its valid signature. */
      gpgKeyId: z.string().min(1).optional(),
      /** GNUPGHOME used to sign and verify anchor commits (default: aocd's environment). */
      gnupgHome: z.string().min(1).optional(),
      /** CA bundle for `openssl ts -verify` of RFC 3161 tokens; without it only the imprint and the time are checked. */
      tsaCaFile: z.string().min(1).optional(),
      /** Intermediate certificates for `openssl ts -verify -untrusted`. */
      tsaUntrustedFile: z.string().min(1).optional(),
      /**
       * Encrypted backups (G-21, R6): one `.aocbk` file per run lands here. Mount off-host storage here, or ship each
       * file with backupCopyCommand. See docs/runbooks/backup-restore.md.
       */
      backupDir: z.string().default('.aoc/backups'),
      /**
       * 32-byte backup key (64 hex chars or base64). Backups run only when it is set. It must not be the KEK and must
       * not live in dataDir, in backupDir or next to keys.masterKeyFile.
       */
      backupKeyFile: z.string().min(1).optional(),
      /** Local time of the daily backup: after anchorAtLocalTime, so every backup is covered by an anchor. */
      backupAtLocalTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')
        .default('02:30'),
      /** Backups older than this are deleted from backupDir; erasure is complete only once they expire (O-12). */
      backupRetentionDays: z.number().int().min(1).max(3650).default(35),
      /** Off-host copy run after each backup, without a shell: `{file}` becomes the backup's path (appended if absent). */
      backupCopyCommand: z.array(z.string()).default([]),
    })
    .default({}),
  intake: z
    .object({
      maxImageBytes: z.number().int().positive().default(10 * 1024 * 1024),
      maxVideoBytes: z.number().int().positive().default(200 * 1024 * 1024),
      maxAttachments: z.number().int().positive().default(6),
      /** `auto`: ClamAV (clamdscan / clamscan on PATH) when present, else the builtin heuristic (not anti-virus). */
      scanner: z.enum(['auto', 'clamav', 'builtin', 'none']).default('auto'),
      /** Reject uploads that cannot be scanned (in production mode: that no anti-virus engine scanned). */
      requireScan: z.boolean().default(true),
      triageAgents: z.number().int().min(1).max(4).default(2),
      diagnosisBudget: z.object({ tokens: z.number().int().positive().default(400_000), minutes: z.number().int().positive().default(30) }).default({}),
      lowConfidenceThreshold: z.number().min(0).max(1).default(0.6),
      triageProcessType: z.string().default('bug-triage'),
      buildProcessType: z.string().default('bug-fix'),
    })
    .default({}),
  selfModification: z
    .object({
      /** Repo roots that ARE the AOC platform itself. */
      aocRepoPaths: z.array(z.string()).default([]),
      /** Governance/audit/credit core (glob-ish prefixes relative to an AOC repo root). */
      protectedPaths: z.array(z.string()).default([...DEFAULT_PROTECTED_PATHS]),
      externalAuditLog: z.string().default('.aoc/selfmod-audit.log'),
    })
    .default({}),
  compliance: z
    .object({
      /** ISO/IEC 42001 control mapping (provisional until stamped by the compliance lead). */
      mappingFile: z.string().default('config/iso42001-mapping.json'),
    })
    .default({}),
  learning: z
    .object({
      retireAfterUnusedRuns: z.number().int().positive().default(20),
      verifyWindowDays: z.number().int().positive().default(14),
    })
    .default({}),
  identity: z
    .object({
      rpId: z.string().default('localhost'),
      rpName: z.string().default('AOC — Agent Ops Console'),
      origin: z.string().default('http://localhost:7420'),
      sessionTtlHours: z.number().int().positive().default(12),
      /** Bootstrap token file for the first Approver (printed once by `aoc init`). */
      bootstrapTokenFile: z.string().optional(),
    })
    .default({}),
});
export type AocConfig = z.infer<typeof AocConfigSchema>;
export const defaultConfig = (): AocConfig => AocConfigSchema.parse({});

/** The effective session isolation: explicit setting, else 'user' once a session user is named or in production. */
export function sessionIsolationOf(config: Pick<AocConfig, 'mode' | 'supervisor'>): 'none' | 'user' {
  const s = config.supervisor;
  return s.isolation ?? (s.sessionUser || config.mode === 'production' ? 'user' : 'none');
}
