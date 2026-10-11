import type { Command } from 'commander';
import type { AdminActionResultDTO, AdminRebuildResultDTO } from '@aoc/contracts';
import { objectOf, type CommandContext } from '../context';
import { EXIT, UsageError } from '../errors';
import { renderKv } from '../format';
import { ApiError } from '../http';
import { API_PATHS } from '../paths';

/** A rebuild or a job can take minutes on a large log. */
const LONG_MS = 30 * 60_000;

function approverTokenHint(err: unknown): never {
  if (err instanceof ApiError && err.status === 403)
    throw new ApiError(
      err.message,
      403,
      err.code,
      err.details,
      EXIT.AUTH,
      'admin actions need the Approver token (permission ops.admin), which a Builder token lacks; run `aoc login --token <approver token>` (or set AOC_TOKEN)',
    );
  throw err;
}

/**
 * Operator actions on the runtime (threat model O-26). Each one is recorded as an event naming who ran it and the
 * `--reason`, with how it went; a failed action exits 1.
 */
export function registerAdmin(program: Command, ctx: CommandContext): void {
  const admin = program
    .command('admin')
    .description('audited operator actions on aocd: re-drive a dead-lettered reaction, rebuild projections, run a job (Approver token, permission ops.admin)');

  const report = (r: AdminActionResultDTO, json: boolean | undefined, done: string, extra: [string, string][] = []) => {
    if (r.outcome !== 'ok') ctx.exitCode = EXIT.ERROR;
    if (json) return ctx.json(r);
    ctx.print(
      renderKv([
        ['Outcome', r.outcome === 'ok' ? done : `FAILED — ${r.error ?? 'unknown error'}`],
        ...extra,
        ['Recorded', `event seq ${r.eventSeq}`],
      ]),
    );
  };

  admin
    .command('redrive')
    .description('re-run one reactor on one event whose reaction was dead-lettered (GET /api/audit/health lists the recent ones)')
    .argument('<reactor>', 'reactor name, e.g. intake.triage-on-submit')
    .argument('<seq>', 'seq of the failed event')
    .requiredOption('--reason <text>', 'why: recorded with the action')
    .option('--json', 'machine-readable output')
    .action(async (reactor: string, seqArg: string, opts: { reason: string; json?: boolean }, cmd: Command) => {
      const seq = Number(seqArg);
      if (!Number.isInteger(seq) || seq < 1) throw new UsageError(`seq must be a positive integer, got "${seqArg}"`);
      const r = objectOf<AdminActionResultDTO>(
        await ctx
          .api(cmd, LONG_MS)
          .post(API_PATHS.adminRedrive(reactor), { seq, reason: opts.reason })
          .catch(approverTokenHint),
        'redrive',
        'result',
      );
      report(r, opts.json, `re-driven: ${reactor} ran on seq ${seq}`);
    });

  admin
    .command('rebuild')
    .description('drop and rebuild the named projections from the log (stop running sessions first: hooks wait meanwhile)')
    .argument('<projector...>', 'projector names, e.g. sessions decisions')
    .requiredOption('--reason <text>', 'why: recorded with the action')
    .option('--json', 'machine-readable output')
    .action(async (projectors: string[], opts: { reason: string; json?: boolean }, cmd: Command) => {
      const r = objectOf<AdminRebuildResultDTO>(
        await ctx
          .api(cmd, LONG_MS)
          .post(API_PATHS.adminRebuild, { projectors, reason: opts.reason })
          .catch(approverTokenHint),
        'rebuild',
        'result',
      );
      if (r.degraded.length) ctx.exitCode = EXIT.ERROR;
      report(r, opts.json, `rebuilt: ${r.projectors.join(', ')}`, r.degraded.length ? [['Degraded', r.degraded.join(', ')]] : []);
    });

  admin
    .command('run-job')
    .description('run a scheduled job now, by name (jobs are idempotent; a daily job runs again even if it ran today)')
    .argument('<job>', 'job name, e.g. metering.close-days')
    .requiredOption('--reason <text>', 'why: recorded with the action')
    .option('--json', 'machine-readable output')
    .action(async (job: string, opts: { reason: string; json?: boolean }, cmd: Command) => {
      const r = objectOf<AdminActionResultDTO>(
        await ctx
          .api(cmd, LONG_MS)
          .post(API_PATHS.adminRunJob(job), { reason: opts.reason })
          .catch(approverTokenHint),
        'run-job',
        'result',
      );
      report(r, opts.json, `ran: ${job}`);
    });
}
