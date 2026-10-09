/**
 * `aoc run` asks the daemon to launch a managed session. Credential isolation (§3): this command never
 * spawns `claude` and never reads or forwards credentials — the supervisor launches the process inside a
 * controlled environment. The request carries exactly the LaunchRequest fields below, nothing from the
 * developer's shell.
 */
import type { Command } from 'commander';
import type { LaunchRequest } from '@aoc/contracts';
import { str, type CommandContext } from '../context';
import { CliError } from '../errors';
import { followSession } from '../follow';
import { isRecord } from '../http';
import { API_PATHS, CONSOLE_PATHS } from '../paths';

export function buildLaunchRequest(o: {
  type: string;
  project: string;
  prompt: string;
  phase?: string;
  thread?: string;
  change?: string;
  cwd?: string | null;
}): LaunchRequest {
  return {
    processType: o.type,
    projectId: o.project,
    phaseId: o.phase ?? null,
    threadId: o.thread ?? null,
    cwd: o.cwd ?? null,
    prompt: o.prompt,
    ...(o.change ? { changeId: o.change } : {}),
  };
}

interface RunOpts {
  type: string;
  project: string;
  phase?: string;
  thread?: string;
  change?: string;
  cwd?: string;
  follow?: boolean;
  json?: boolean;
}

export function registerRun(program: Command, ctx: CommandContext): void {
  program
    .command('run')
    .description('launch a managed session; the supervisor spawns claude — this CLI never does')
    .requiredOption('--type <processType>', 'process type from the fixed registry (it decides the model)')
    .requiredOption('--project <projectId>', 'project the work belongs to')
    .option('--phase <phaseId>', 'plan phase the new tasks land in')
    .option('--thread <threadId>', 'durable project thread to continue')
    .option('--change <changeId>', 'change record the work is done under (its commits carry the AOC-Change trailer)')
    .option('--cwd <dir>', 'working directory for the session (default: chosen by the supervisor)')
    .option('--follow', 'stream output and liveness until the session waits on you or ends')
    .option('--json', 'machine-readable output (NDJSON events with --follow)')
    .argument('<prompt...>', 'opening prompt ("-" reads it from stdin)')
    .action(async (promptParts: string[], opts: RunOpts, cmd: Command) => {
      const prompt = await ctx.text(promptParts, 'prompt');
      const req = buildLaunchRequest({ ...opts, prompt, cwd: opts.cwd ? ctx.resolvePath(opts.cwd) : null });
      const api = ctx.api(cmd, 30_000);
      const res = await api.post<unknown>(API_PATHS.sessions, req);
      const body = isRecord(res) ? res : {};
      const nested = isRecord(body.session) ? body.session : {};
      const sessionId = str(body.sessionId) ?? str(nested.sessionId) ?? str(body.id);
      if (!sessionId) throw new CliError('the daemon accepted the launch but returned no session id');
      const consoleUrl = str(body.consoleUrl) ?? ctx.consoleUrl(cmd, CONSOLE_PATHS.session(sessionId));

      if (opts.json) {
        ctx.print(
          JSON.stringify(
            { event: 'launched', ...body, sessionId, consoleUrl },
            null,
            opts.follow ? undefined : 2,
          ),
        );
      } else {
        const model = str(body.model) ?? str(nested.model);
        ctx.print(
          `Launched ${sessionId} (${opts.type}${model ? ` on ${model}` : ''}, project ${opts.project})`,
        );
        ctx.print(`Console: ${consoleUrl}`);
      }
      if (opts.follow) {
        if (!opts.json) ctx.print('Following — Ctrl-C stops following; the session keeps running.');
        ctx.exitCode = await followSession(ctx, api, sessionId, { json: !!opts.json });
      }
    });
}
