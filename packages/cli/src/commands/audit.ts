import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { objectOf, str, type CommandContext } from '../context';
import { CliError, EXIT, UsageError } from '../errors';
import { oneLine, renderKv } from '../format';
import { isRecord, toApiError, type RawResponse } from '../http';
import { API_PATHS } from '../paths';

export interface VerifyResult {
  ok: boolean;
  headSeq?: number;
  checked?: number;
  anchorsChecked?: number;
  anchorsMatched?: number;
  firstBadSeq?: number | null;
  problems?: string[];
}

/** Verify passes only when the chain recomputes AND every external anchor matches (§13, R2). */
export function verifyExitCode(r: VerifyResult): number {
  const anchorsOk = (r.anchorsMatched ?? 0) === (r.anchorsChecked ?? 0);
  return r.ok && anchorsOk ? EXIT.OK : EXIT.ERROR;
}

export function renderVerify(r: VerifyResult): string {
  const lines = [
    r.ok
      ? `Chain OK — ${r.checked ?? '?'} events recomputed, head seq ${r.headSeq ?? '?'}`
      : `Chain BROKEN${r.firstBadSeq != null ? ` at seq ${r.firstBadSeq}` : ''} — ${r.checked ?? '?'} events checked`,
  ];
  const checked = r.anchorsChecked ?? 0;
  const matched = r.anchorsMatched ?? 0;
  if (checked === 0) {
    lines.push(
      'Anchors: none yet — the in-file chain alone is defeatable (R2); anchor it off-host with `aoc anchor`',
    );
  } else {
    lines.push(
      `Anchors: ${matched}/${checked} external anchors match${matched === checked ? '' : ' — MISMATCH: the log was rewritten after anchoring'}`,
    );
  }
  for (const p of r.problems ?? []) lines.push(`  - ${oneLine(p)}`);
  return lines.join('\n');
}

export function parseDay(value: string, flag: string): string {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  // Round-tripping rejects dates JS would roll over (2026-02-30 → March 2).
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) {
    throw new UsageError(`${flag} must be a calendar date YYYY-MM-DD (got "${value}")`);
  }
  return value;
}

function isZip(r: RawResponse): boolean {
  const b = r.bytes;
  return (
    /zip|octet-stream/i.test(r.contentType) ||
    (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04)
  );
}

function kib(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}

export function registerAudit(program: Command, ctx: CommandContext): void {
  program
    .command('verify')
    .description('recompute the hash chain and test it against the external anchors')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const r = objectOf<VerifyResult>(
        await ctx.api(cmd, 300_000).get(API_PATHS.auditVerify),
        'verify',
        'result',
      );
      ctx.exitCode = verifyExitCode(r);
      if (opts.json) return ctx.json(r);
      ctx.print(renderVerify(r));
    });

  program
    .command('anchor')
    .description('anchor the current chain head off-host now (signed commit / RFC 3161)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const r = objectOf<Record<string, unknown>>(
        await ctx.api(cmd, 120_000).post(API_PATHS.auditAnchor, {}),
        'anchor',
        'anchor',
      );
      if (opts.json) return ctx.json(r);
      const hash = str(r.hash);
      ctx.print(
        renderKv([
          ['Anchored', `head seq ${r.seq ?? '?'}${hash ? ` (${hash.slice(0, 16)}…)` : ''}`],
          ['Provider', r.provider],
          ['Proof', r.proofRef],
          ['Anchor id', r.anchorId],
        ]),
      );
    });

  program
    .command('evidence')
    .description('generate a frozen, hash-verified evidence pack for a date range and download it')
    .requiredOption('--from <date>', 'first day (YYYY-MM-DD)')
    .requiredOption('--to <date>', 'last day (YYYY-MM-DD)')
    .option('--out <file>', 'where to save the pack (default: ./aoc-evidence-<from>_<to>.zip)')
    .option('--force', 'overwrite --out if it exists')
    .option('--json', 'machine-readable output')
    .action(
      async (
        opts: { from: string; to: string; out?: string; force?: boolean; json?: boolean },
        cmd: Command,
      ) => {
        const from = parseDay(opts.from, '--from');
        const to = parseDay(opts.to, '--to');
        if (from > to) throw new UsageError(`--from ${from} is after --to ${to}`);
        const api = ctx.api(cmd, 300_000);
        const zipAccept = 'application/zip, application/octet-stream';

        const created = await api.raw(
          'POST',
          API_PATHS.evidencePacks,
          { from, to },
          { accept: `application/json, ${zipAccept}` },
        );
        if (created.status < 200 || created.status >= 300)
          throw toApiError(created, 'POST', API_PATHS.evidencePacks);
        let meta: Record<string, unknown> = {};
        let zip = created;
        if (!isZip(created)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder().decode(created.bytes));
          } catch {
            throw new CliError(
              `unexpected response from POST ${API_PATHS.evidencePacks} (${created.contentType || 'no content type'})`,
            );
          }
          meta = isRecord(parsed) && isRecord(parsed.pack) ? parsed.pack : isRecord(parsed) ? parsed : {};
          const packId = str(meta.packId) ?? str(meta.id);
          const link = str(meta.downloadUrl) ?? (packId ? API_PATHS.evidencePackDownload(packId) : null);
          if (!link)
            throw new CliError(
              'the daemon generated a pack but returned neither a pack id nor a download URL',
            );
          const path = api.pathFor(link);
          zip = await api.raw('GET', path, undefined, { accept: zipAccept });
          if (zip.status < 200 || zip.status >= 300) throw toApiError(zip, 'GET', path);
          if (!isZip(zip))
            throw new CliError(
              `expected a zip from GET ${path}, got ${zip.contentType || 'an unknown type'}`,
            );
        }

        const out = ctx.resolvePath(opts.out ?? `aoc-evidence-${from}_${to}.zip`);
        try {
          writeFileSync(out, zip.bytes, { mode: 0o600, flag: opts.force ? 'w' : 'wx' });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST')
            throw new CliError(`${out} already exists`, EXIT.ERROR, { hint: 'pass --force to overwrite' });
          throw err;
        }
        const sha256 = createHash('sha256').update(zip.bytes).digest('hex');
        const packHash = str(meta.packHash);
        if (meta.chainOk === false) ctx.exitCode = EXIT.ERROR;
        if (opts.json) return ctx.json({ ...meta, file: out, bytes: zip.bytes.length, sha256 });

        const stamped = meta.mappingStamped;
        ctx.print(
          renderKv([
            ['Pack', str(meta.packId) ?? str(meta.id) ?? '—'],
            ['Range', `${from} → ${to}`],
            ['Events', meta.eventCount ?? undefined],
            [
              'Chain',
              typeof meta.chainOk === 'boolean'
                ? meta.chainOk
                  ? 'verified OK'
                  : 'BROKEN — see `aoc verify`'
                : undefined,
            ],
            [
              'Mapping',
              typeof stamped === 'boolean'
                ? `${String(meta.mappingVersion ?? '?')} — ${stamped ? 'stamped by the compliance lead' : 'PROVISIONAL (not yet stamped by the compliance lead)'}`
                : undefined,
            ],
            ['Saved', `${out} (${kib(zip.bytes.length)})`],
            ['SHA-256', packHash && packHash === sha256 ? `${sha256} (matches the pack hash)` : sha256],
            ['Pack hash', packHash && packHash !== sha256 ? packHash : undefined],
          ]),
        );
      },
    );
}
