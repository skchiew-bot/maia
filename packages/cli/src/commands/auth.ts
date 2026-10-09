import type { Command } from 'commander';
import type { User } from '@aoc/contracts';
import {
  DEFAULT_DAEMON_URL,
  ENV_DAEMON_URL,
  ENV_TOKEN,
  isLoopbackUrl,
  normalizeDaemonUrl,
  saveClientConfig,
  type ValueSource,
} from '../config';
import type { CommandContext, GlobalOpts } from '../context';
import { CliError, EXIT, UsageError } from '../errors';
import { renderKv } from '../format';
import { Api, ApiError, isRecord } from '../http';
import { API_PATHS } from '../paths';

/** User endpoints may answer with a wrapper ({ user, … } — e.g. the AuthContext) or the bare user. */
export function userOf(data: unknown, route = `GET ${API_PATHS.authMe}`): User {
  const u = isRecord(data) && isRecord(data.user) ? data.user : data;
  if (!isRecord(u) || typeof u.id !== 'string' || typeof u.role !== 'string') {
    throw new CliError(`unexpected response from ${route} (no user)`);
  }
  return u as unknown as User;
}

function sourceLabel(source: ValueSource, envName: string, flag: string, configPath: string): string {
  return { flag, env: `$${envName}`, config: configPath, default: 'built-in default', none: 'none' }[source];
}

export function registerAuth(program: Command, ctx: CommandContext): void {
  program
    .command('login')
    .description('verify a token with the daemon and store it in ~/.aoc/client.json (mode 0600)')
    .addHelpText(
      'after',
      '\nUse the global --token flag; "--token -" reads the token from stdin (keeps it out of shell history).',
    )
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      if (!g.token) throw new UsageError('login needs a token', 'aoc login --token <token> [--daemon <url>]');
      const token = await ctx.secret(g.token, 'token');
      const existing = ctx.config();
      const daemonUrl = normalizeDaemonUrl(
        g.daemon ?? ctx.deps.env[ENV_DAEMON_URL] ?? existing?.daemonUrl ?? DEFAULT_DAEMON_URL,
      );
      if (daemonUrl.startsWith('http:') && !isLoopbackUrl(daemonUrl)) {
        ctx.warn(
          `warning: ${daemonUrl} is plain HTTP on a non-loopback host — the token travels unencrypted`,
        );
      }
      let user: User;
      try {
        user = userOf(await new Api({ daemonUrl, token }, ctx.deps.fetch).get(API_PATHS.authMe));
      } catch (err) {
        if (err instanceof ApiError && err.exitCode === EXIT.AUTH) {
          throw new CliError(`token rejected by ${daemonUrl} (${err.message})`, EXIT.AUTH);
        }
        throw err;
      }
      saveClientConfig(ctx.configPath, { ...existing, daemonUrl, token });
      if (opts.json) return ctx.json({ daemonUrl, user, configPath: ctx.configPath });
      ctx.print(`Logged in to ${daemonUrl} as ${user.name} (${user.role}, ${user.id}).`);
      ctx.print(`Token stored in ${ctx.configPath} (0600).`);
    });

  program
    .command('logout')
    .description('remove the stored CLI token (the observer token used by observed hooks is kept)')
    .action(() => {
      const existing = ctx.config();
      if (!existing?.token) {
        ctx.print('Not logged in (no token stored).');
      } else {
        saveClientConfig(ctx.configPath, { ...existing, token: undefined });
        ctx.print(`Logged out: token removed from ${ctx.configPath}.`);
        ctx.print('The token itself stays valid on the daemon until it is revoked in the console.');
      }
      if (ctx.deps.env[ENV_TOKEN])
        ctx.warn(`warning: ${ENV_TOKEN} is still set in this shell and will keep being used.`);
    });

  program
    .command('whoami')
    .description('show who the current token belongs to')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const target = ctx.target(cmd);
      if (!target.token)
        throw new CliError('not logged in', EXIT.AUTH, {
          hint: 'run `aoc login --token <token>` (or set AOC_TOKEN)',
        });
      const user = userOf(await ctx.api(cmd).get(API_PATHS.authMe));
      if (opts.json) return ctx.json({ user, daemonUrl: target.daemonUrl, tokenSource: target.tokenSource });
      ctx.print(
        renderKv([
          ['User', `${user.name} (${user.id})`],
          ['Role', user.role + (user.flags?.complianceLead ? ' · compliance lead' : '')],
          [
            'Daemon',
            `${target.daemonUrl} (from ${sourceLabel(target.daemonSource, ENV_DAEMON_URL, '--daemon', ctx.configPath)})`,
          ],
          ['Token', `from ${sourceLabel(target.tokenSource, ENV_TOKEN, '--token', ctx.configPath)}`],
        ]),
      );
    });
}
