import type { TaskSize } from '@aoc/contracts';

export interface PlanTask {
  id: string;
  title: string;
  size: TaskSize;
}
export interface Plan {
  phases: { id: string; name: string; tasks: PlanTask[] }[];
}
export type PlanKind = 'feature' | 'fix' | 'docs';

/**
 * Plan manifests of the seeded sessions. Task ids are distinct across manifests (`<tag>-<n>`, the tag naming the
 * session): the ledger refuses a task id already completed in a thread and the master timeline counts a task once,
 * so two sessions of a project must never share one. The three sessions that work again on claude-sim use the tags
 * their continuation scenarios close (`dedupe`, `csat`, `runbook`: packages/claude-sim/scenarios/demo-*-*.json).
 */
export function planFor(kind: PlanKind, tag: string): Plan {
  const id = (n: number) => `${tag}-${n}`;
  switch (kind) {
    case 'feature':
      return {
        phases: [
          {
            id: 'design',
            name: 'Design',
            tasks: [
              { id: id(1), title: 'Map current flow and data contracts', size: 's' },
              { id: id(2), title: 'Write API contract + acceptance tests', size: 'm' },
            ],
          },
          {
            id: 'build',
            name: 'Build',
            tasks: [
              { id: id(3), title: 'Implement service layer', size: 'l' },
              { id: id(4), title: 'Wire UI and telemetry events', size: 'm' },
              { id: id(5), title: 'Edge cases + error states', size: 's' },
            ],
          },
          { id: 'verify', name: 'Verify', tasks: [{ id: id(6), title: 'Regression suite green', size: 's' }] },
        ],
      };
    case 'fix':
      return {
        phases: [
          { id: 'reproduce', name: 'Reproduce', tasks: [{ id: id(1), title: 'Failing test reproducing the bug', size: 's' }] },
          {
            id: 'fix',
            name: 'Fix',
            tasks: [
              { id: id(2), title: 'Root-cause fix', size: 'm' },
              { id: id(3), title: 'Guard + regression test', size: 's' },
            ],
          },
        ],
      };
    case 'docs':
      return {
        phases: [
          {
            id: 'docs',
            name: 'Docs',
            tasks: [
              { id: id(1), title: 'Update runbook', size: 'xs' },
              { id: id(2), title: 'Add diagrams', size: 's' },
              { id: id(3), title: 'Review links', size: 'xs' },
            ],
          },
        ],
      };
  }
}

export const taskCount = (p: Plan): number => p.phases.reduce((n, ph) => n + ph.tasks.length, 0);
