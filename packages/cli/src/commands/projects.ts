import type { Command } from 'commander';
import type { ProjectSummary, ProjectTimeline } from '@aoc/contracts';
import { listOf, objectOf, str, type CommandContext } from '../context';
import { CliError } from '../errors';
import { formatAge, progressCell, renderTable, renderTimeline, tasksCell } from '../format';
import { isRecord } from '../http';
import { API_PATHS } from '../paths';

export function renderProjects(projects: ProjectSummary[], now: number): string {
  if (projects.length === 0)
    return 'No projects yet. Create one with: aoc project create --name <name> --repo <path>';
  return renderTable(
    [
      { header: 'ID' },
      { header: 'NAME', max: 32 },
      { header: 'PROGRESS' },
      { header: 'TASKS', align: 'right' },
      { header: 'SESSIONS', align: 'right' },
      { header: 'DECISIONS', align: 'right' },
      { header: 'ACTIVE', align: 'right' },
      { header: 'REPO', max: 48 },
    ],
    projects.map((p) => [
      p.projectId,
      p.name,
      progressCell(p.progress),
      tasksCell(p.progress),
      p.activeSessions,
      p.openDecisions,
      p.lastActivityAt ? `${formatAge(p.lastActivityAt, now)} ago` : '—',
      p.repoPath ?? '—',
    ]),
  );
}

export function registerProjects(program: Command, ctx: CommandContext): void {
  program
    .command('projects')
    .description('list projects with measured progress')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const projects = listOf<ProjectSummary>(
        await ctx.api(cmd).get(API_PATHS.projects),
        'projects',
        'projects',
        'items',
      );
      if (opts.json) return ctx.json(projects);
      ctx.print(renderProjects(projects, ctx.deps.now()));
    });

  const project = program.command('project').description('manage projects');
  project
    .command('create')
    .description('create a project (the durable unit of work)')
    .requiredOption('--name <name>', 'project name')
    .requiredOption('--repo <path>', 'git repository path (resolved to an absolute path)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { name: string; repo: string; json?: boolean }, cmd: Command) => {
      const repoPath = ctx.resolvePath(opts.repo);
      const res = await ctx.api(cmd).post<unknown>(API_PATHS.projects, { name: opts.name, repoPath });
      if (opts.json) return ctx.json(res);
      const body = isRecord(res) ? (isRecord(res.project) ? res.project : res) : {};
      const id = str(body.projectId) ?? str(body.id);
      if (!id) throw new CliError('the daemon created the project but returned no project id');
      ctx.print(`Created project ${opts.name} (${id}) → ${repoPath}`);
    });

  program
    .command('timeline')
    .description('master project timeline: stacked per-phase bar with numbers')
    .argument('<projectId>')
    .option('--width <cells>', 'width of the overall bar', '40')
    .option('--json', 'machine-readable output')
    .action(async (projectId: string, opts: { width: string; json?: boolean }, cmd: Command) => {
      const t = objectOf<ProjectTimeline>(
        await ctx.api(cmd).get(API_PATHS.projectTimeline(projectId)),
        'timeline',
        'timeline',
      );
      if (opts.json) return ctx.json(t);
      if (!Array.isArray(t.phases) || !isRecord(t.progress))
        throw new CliError('unexpected timeline response from the daemon');
      const cells = Math.min(120, Math.max(10, Number.parseInt(opts.width, 10) || 40));
      ctx.print(renderTimeline({ ...t, manifest: t.manifest ?? [], amendments: t.amendments ?? [] }, cells));
    });
}
