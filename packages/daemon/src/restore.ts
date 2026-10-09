import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AocConfig } from '@aoc/contracts';
import { keyFingerprint, parseKey } from '@aoc/kernel';
import { restoreBackup, RestoreError, type RestoreReport } from '@aoc/mod-audit';
import { ConfigError, loadConfig } from './config';

export const RESTORE_USAGE = `Usage: aocd restore --from <backup.aocbk> --backup-key-file <file> --kek-file <file>
                    [--data-dir <dir>] [--config <file>]
                    [--anchor-remote <url> | --anchor-repo <dir> | --no-anchors] [--require-anchor] [--json]

Restores an encrypted backup into an EMPTY data dir (default: the configured dataDir) with aocd stopped. Everything
is decrypted into a staging directory and checked first — the manifest, the KEK against every data key, the hash
chain, every body and blob, and the chain against the off-host anchors (by default a fresh clone of
audit.anchorRemote) — and only a backup that passes is moved into place. The KEK and the backup key must be
supplied as files from their own custody; the KEK is never written into the data dir.
See docs/runbooks/backup-restore.md.
`;

export interface RestoreArgs {
  from: string;
  backupKeyFile: string;
  kekFile: string;
  dataDir: string | null;
  config: string | null;
  anchorRemote: string | null;
  anchorRepo: string | null;
  noAnchors: boolean;
  requireAnchor: boolean;
  json: boolean;
}

export class RestoreUsageError extends Error {}

export function parseRestoreArgs(argv: readonly string[]): RestoreArgs | 'help' {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const VALUE = ['--from', '--backup-key-file', '--kek-file', '--data-dir', '--config', '--anchor-remote', '--anchor-repo'];
  const FLAG = ['--no-anchors', '--require-anchor', '--json'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') return 'help';
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE.includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (!v || v.startsWith('--')) throw new RestoreUsageError(`${name} needs a value`);
      values[name] = v;
    } else if (FLAG.includes(a)) flags.add(a);
    else throw new RestoreUsageError(`unknown argument "${a}"`);
  }
  for (const required of ['--from', '--backup-key-file', '--kek-file'])
    if (!values[required]) throw new RestoreUsageError(`${required} is required`);
  const sources = [values['--anchor-remote'], values['--anchor-repo'], flags.has('--no-anchors') || undefined].filter(Boolean);
  if (sources.length > 1)
    throw new RestoreUsageError('choose one of --anchor-remote, --anchor-repo and --no-anchors');
  return {
    from: values['--from']!,
    backupKeyFile: values['--backup-key-file']!,
    kekFile: values['--kek-file']!,
    dataDir: values['--data-dir'] ?? null,
    config: values['--config'] ?? null,
    anchorRemote: values['--anchor-remote'] ?? null,
    anchorRepo: values['--anchor-repo'] ?? null,
    noAnchors: flags.has('--no-anchors'),
    requireAnchor: flags.has('--require-anchor'),
    json: flags.has('--json'),
  };
}

class KeyFileError extends Error {}

function readKey(file: string, what: string): Buffer {
  try {
    return parseKey(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new KeyFileError(`cannot use the ${what} file ${file}: ${(err as Error).message}`);
  }
}

/** What aocd would load as its KEK on the next start, compared with the KEK the backup was restored with. */
function kekAdvice(config: AocConfig, env: Record<string, string | undefined>, kek: Buffer): string | null {
  const want = keyFingerprint(kek, 'kek');
  if (env.AOC_MASTER_KEY) {
    try {
      if (keyFingerprint(parseKey(env.AOC_MASTER_KEY), 'kek') === want) return null;
    } catch {
      // reported below
    }
    return 'AOC_MASTER_KEY holds a different KEK: unset it, or aocd cannot decrypt the restored bodies';
  }
  const file = config.keys.masterKeyFile;
  if (!file)
    return `keys.masterKeyFile is not set: aocd would look for the KEK in the data dir and refuse to start without one ("refusing to generate a new KEK", since the restored data needs the original). Put the escrowed KEK outside the data dir and set keys.masterKeyFile before starting aocd`;
  if (!existsSync(file)) return `keys.masterKeyFile (${file}) does not exist yet: put the escrowed KEK there before starting aocd`;
  try {
    if (keyFingerprint(parseKey(readFileSync(file, 'utf8')), 'kek') === want) return null;
  } catch {
    // reported below
  }
  return `keys.masterKeyFile (${file}) holds a different KEK than the one this backup needs (${want})`;
}

function render(r: RestoreReport, advice: string | null): string {
  const lines: string[] = [];
  if (r.ok) lines.push(`Restored backup ${r.backupId} (taken ${r.createdAt}) into ${r.dataDir}`);
  else lines.push(`Restore FAILED — nothing was written to ${r.dataDir}`);
  lines.push(
    `  chain    ${r.chain.ok ? 'OK' : 'BROKEN'} — ${r.chain.checked} events recomputed, head seq ${r.headSeq} (${r.headHash.slice(0, 16)}…)`,
    `  anchors  ${r.anchors.matched}/${r.anchors.checked} off-host anchors confirm the chain${r.anchors.sources.length ? ` (${r.anchors.sources.join(', ')})` : ''}; ${r.anchors.newerThanBackup} newer than the backup`,
    `  bodies   ${r.bodies.verified} verified, ${r.bodies.erased} erased, ${r.bodies.missing} missing, ${r.bodies.tampered} altered`,
    `  blobs    ${r.blobs.decrypted} decrypted, ${r.blobs.missing} missing`,
    `  KEK      ${r.kek.kekId} unwraps ${r.kek.keysUnwrapped} data keys (never copied into the data dir)`,
  );
  for (const p of r.problems) lines.push(`  problem: ${p}`);
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  if (r.ok) {
    lines.push('Next:');
    if (advice) lines.push(`  - ${advice}`);
    lines.push('  - start aocd, then run `aoc verify` (Verify against every off-host anchor) before any other work');
  }
  return `${lines.join('\n')}\n`;
}

export interface RestoreIo {
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/** `aocd restore …`: resolves to the exit code (0 restored, 1 refused or failed, 2 usage). */
export async function runRestoreCommand(argv: readonly string[], io: RestoreIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const out = io.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = io.stderr ?? ((s: string) => void process.stderr.write(s));
  let args: RestoreArgs;
  try {
    const parsed = parseRestoreArgs(argv);
    if (parsed === 'help') {
      out(RESTORE_USAGE);
      return 0;
    }
    args = parsed;
  } catch (e) {
    if (!(e instanceof RestoreUsageError)) throw e;
    err(`aocd restore: ${e.message}\n${RESTORE_USAGE}`);
    return 2;
  }
  let config: AocConfig;
  try {
    config = loadConfig({ argv: args.config ? ['--config', args.config] : [], env, cwd }).config;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    err(`aocd restore: ${e.message}\n`);
    return 1;
  }
  const path = (p: string) => resolve(cwd, p);
  try {
    const kek = readKey(path(args.kekFile), 'KEK');
    const backupKey = readKey(path(args.backupKeyFile), 'backup key');
    const audit = config.audit;
    const anchors = args.noAnchors
      ? null
      : {
          gitRemote: args.anchorRemote ?? (args.anchorRepo ? null : (audit.anchorRemote ?? null)),
          gitRepo: args.anchorRepo ? path(args.anchorRepo) : audit.anchorRepoPath,
          gpgKeyId: audit.gpgKeyId,
          gnupgHome: audit.gnupgHome,
          tsaCaFile: audit.tsaCaFile,
          tsaUntrustedFile: audit.tsaUntrustedFile,
        };
    const report = await restoreBackup({
      file: path(args.from),
      backupKey,
      kek,
      dataDir: args.dataDir ? path(args.dataDir) : config.dataDir,
      anchors,
      requireAnchor: args.requireAnchor,
    });
    const advice = report.ok ? kekAdvice(config, env, kek) : null;
    if (args.json) out(`${JSON.stringify({ ...report, kekAdvice: advice }, null, 2)}\n`);
    else out(render(report, advice));
    return report.ok ? 0 : 1;
  } catch (e) {
    if (!(e instanceof RestoreError) && !(e instanceof KeyFileError)) throw e;
    err(`aocd restore: ${e.message}\n`);
    return 1;
  }
}
