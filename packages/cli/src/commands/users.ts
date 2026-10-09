import { Option, type Command } from 'commander';
import { ROLES, type User } from '@aoc/contracts';
import { listOf, str, type CommandContext } from '../context';
import { CliError } from '../errors';
import { renderTable } from '../format';
import { isRecord } from '../http';
import { API_PATHS } from '../paths';
import { userOf } from './auth';

export function renderUsers(users: User[]): string {
  if (users.length === 0) return 'No users.';
  return renderTable(
    [
      { header: 'ID' },
      { header: 'NAME', max: 32 },
      { header: 'ROLE' },
      { header: 'FLAGS' },
      { header: 'ACTIVE' },
      { header: 'EMAIL', max: 40 },
    ],
    users.map((u) => [
      u.id,
      u.name,
      u.role,
      u.flags?.complianceLead ? 'compliance lead' : '—',
      u.active === false ? 'no' : 'yes',
      u.email ?? '—',
    ]),
  );
}

/** Print a freshly issued secret exactly once: the bare token on stdout (pipe-friendly), the warning on stderr. */
function printTokenOnce(ctx: CommandContext, token: string, about: string): void {
  ctx.print(token);
  ctx.warn(`${about}\nThis token is shown once and cannot be retrieved again — store it now.`);
}

export function registerUsers(program: Command, ctx: CommandContext): void {
  const users = program
    .command('users')
    .description('manage people and roles (approver | builder | requester)');

  users
    .command('list')
    .description('list users')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const list = listOf<User>(await ctx.api(cmd).get(API_PATHS.users), 'users', 'users', 'items');
      if (opts.json) return ctx.json(list);
      ctx.print(renderUsers(list));
    });

  users
    .command('add')
    .description('give a person an identity and a role')
    .requiredOption('--name <name>', 'display name')
    .addOption(new Option('--role <role>', 'role').choices(ROLES).makeOptionMandatory())
    .option('--email <email>', 'email address')
    .option('--compliance-lead', 'may stamp the ISO 42001 mapping')
    .option('--json', 'machine-readable output')
    .action(
      async (
        opts: { name: string; role: string; email?: string; complianceLead?: boolean; json?: boolean },
        cmd: Command,
      ) => {
        const res = await ctx.api(cmd).post<unknown>(API_PATHS.users, {
          name: opts.name,
          role: opts.role,
          email: opts.email,
          complianceLead: !!opts.complianceLead,
        });
        if (opts.json) return ctx.json(res);
        const user = userOf(res, `POST ${API_PATHS.users}`);
        ctx.print(
          `Created ${user.name} (${user.id}) as ${user.role}${opts.complianceLead ? ', compliance lead' : ''}.`,
        );
        const token = isRecord(res) ? str(res.token) : null;
        if (token) printTokenOnce(ctx, token, `Initial token for ${user.id} printed above.`);
      },
    );

  const token = program.command('token').description('API tokens');
  token
    .command('create')
    .description('issue a bearer token (yours unless --user is given); printed once')
    .option('--user <userId>', 'user to issue the token for (default: you)')
    .option('--label <label>', 'label shown in the console')
    .option('--json', 'machine-readable output')
    .action(async (opts: { user?: string; label?: string; json?: boolean }, cmd: Command) => {
      const api = ctx.api(cmd);
      const userId = opts.user ?? userOf(await api.get(API_PATHS.authMe)).id;
      const res = await api.post<unknown>(API_PATHS.userTokens(userId), { label: opts.label });
      const secret = isRecord(res) ? str(res.token) : null;
      if (!secret) throw new CliError('the daemon issued no token');
      if (opts.json) return ctx.json(res);
      const tokenId = isRecord(res) ? str(res.tokenId) : null;
      printTokenOnce(
        ctx,
        secret,
        `Token${tokenId ? ` ${tokenId}` : ''} for ${userId}${opts.label ? ` ("${opts.label}")` : ''} printed above.`,
      );
    });
}
