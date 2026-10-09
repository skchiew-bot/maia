/** aocd configuration. `AocConfigSchema.parse({})` yields a complete, safe local default. */
import { z } from 'zod';

const thresholds = z
  .object({
    workingWindowMs: z.number().int().positive().default(30_000),
    stallAfterMs: z.number().int().positive().default(300_000),
    toolStallAfterMs: z.number().int().positive().default(1_200_000),
    deadAfterMs: z.number().int().positive().default(45_000),
  })
  .default({});

export const AocConfigSchema = z.object({
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
      /** JSON file: { profiles: { [name]: { env: Record<string,string> } } } readable only by the supervisor user. */
      credentialProfilesFile: z.string().optional(),
    })
    .default({}),
  decisions: z
    .object({
      /** Opt-in webhook for new/aging decisions (R15). */
      webhookUrl: z.string().url().optional(),
      remindAfterMinutes: z.number().int().positive().default(30),
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
      runAtLocalTime: z.string().default('12:30'),
      pageUrl: z.string().default('https://www.bnm.gov.my/exchange-rates'),
      apiUrl: z.string().default('https://api.bnm.gov.my/public/exchange-rate/USD'),
      extractor: z.enum(['claude-cli', 'anthropic-sdk', 'fake']).default('claude-cli'),
      sanity: z
        .object({ min: z.number().default(3.5), max: z.number().default(5.5), maxDailyChangePct: z.number().default(3) })
        .default({}),
      reconcileTolerance: z.number().default(0.005),
      carryForwardAlertDays: z.number().int().positive().default(4),
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
    })
    .default({}),
  intake: z
    .object({
      maxImageBytes: z.number().int().positive().default(10 * 1024 * 1024),
      maxVideoBytes: z.number().int().positive().default(200 * 1024 * 1024),
      maxAttachments: z.number().int().positive().default(6),
      scanner: z.enum(['clamav', 'builtin', 'none']).default('builtin'),
      /** Reject uploads that cannot be scanned. */
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
      protectedPaths: z
        .array(z.string())
        .default(['packages/kernel/', 'packages/contracts/', 'packages/mod-audit/', 'packages/mod-credits/', 'packages/mod-decisions/', 'packages/mod-identity/', 'packages/hooks/', 'config/']),
      externalAuditLog: z.string().default('.aoc/selfmod-audit.log'),
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
