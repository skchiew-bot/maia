import type { Command } from 'commander';
import type { CommandContext } from '../context';
import { nodeDoctorFs, runDoctor, type DaemonProbe, type DoctorCheck, type Verdict } from '../doctor';
import { EXIT } from '../errors';
import { renderTable } from '../format';
import { Api, ApiError } from '../http';
import { defaultSettingsPath } from '../observed-hooks';
import { API_PATHS } from '../paths';
import { userOf } from './auth';

const PROBE_TIMEOUT_MS = 3000;

export async function probeDaemon(api: Api): Promise<DaemonProbe> {
  try {
    const u = userOf(await api.get(API_PATHS.authMe));
    return { reachable: true, status: 200, user: { id: u.id, name: u.name, role: u.role }, error: null };
  } catch (err) {
    if (err instanceof ApiError)
      return { reachable: err.status !== null, status: err.status, user: null, error: err.message };
    return { reachable: true, status: 200, user: null, error: (err as Error).message };
  }
}

export function renderDoctor(checks: DoctorCheck[], verdict: Verdict, runbook: string): string {
  const table = renderTable(
    [{ header: 'STATUS' }, { header: 'CHECK' }, { header: 'DETAIL' }],
    checks.map((c) => [c.status.toUpperCase(), c.label, c.detail]),
  );
  const count = (s: DoctorCheck['status']) => checks.filter((c) => c.status === s).length;
  const summary = `${count('fail')} failed, ${count('warn')} warnings, ${count('pass')} passed${count('skip') ? `, ${count('skip')} skipped` : ''}`;
  return `${table}\n\nVerdict: ${verdict.toUpperCase()} (${summary})\nCredential-isolation runbook: ${runbook}`;
}

export function registerDoctor(program: Command, ctx: CommandContext): void {
  program
    .command('doctor')
    .description('credential-isolation posture (R1) and health checks; reports names, never secret values')
    .option('--settings <file>', 'Claude Code settings file to inspect (default: ~/.claude/settings.json)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { settings?: string; json?: boolean }, cmd: Command) => {
      const target = ctx.target(cmd);
      const config = ctx.config();
      const result = await runDoctor({
        env: ctx.deps.env,
        homeDir: ctx.deps.homeDir,
        cwd: ctx.deps.cwd,
        platform: ctx.deps.platform,
        fs: nodeDoctorFs,
        git: ctx.deps.git,
        daemonUrl: target.daemonUrl,
        tokenPresent: !!target.token,
        probe: () => probeDaemon(new Api(target, ctx.deps.fetch, PROBE_TIMEOUT_MS)),
        configPath: ctx.configPath,
        observerTokenPresent: !!config?.observerToken,
        settingsPath: opts.settings
          ? ctx.resolvePath(opts.settings)
          : defaultSettingsPath(ctx.deps.env, ctx.deps.homeDir),
      });
      ctx.exitCode = result.verdict === 'fail' ? EXIT.ERROR : EXIT.OK;
      if (opts.json) return ctx.json(result);
      ctx.print(renderDoctor(result.checks, result.verdict, result.runbook));
    });
}
