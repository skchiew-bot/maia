import type { Actor, DecisionRequestInput, Notification, Role } from '@aoc/contracts';
import { createTestRuntime, type AocModule, type Logger, type TestRuntime, type TestUser } from '@aoc/kernel';
import { createDecisionsModule, type DecisionEngine, type DecisionsModuleOptions } from '../src';

export interface Harness {
  t: TestRuntime;
  mod: AocModule;
  engine: DecisionEngine;
  approver: TestUser;
  approver2: TestUser;
  builderA: TestUser;
  builderB: TestUser;
  requester: TestUser;
  requester2: TestUser;
}

export async function harness(
  opts: {
    module?: DecisionsModuleOptions;
    config?: Parameters<typeof createTestRuntime>[0]['config'];
    log?: Logger;
  } = {},
): Promise<Harness> {
  const mod = createDecisionsModule(opts.module);
  const t = await createTestRuntime({ modules: [mod], config: opts.config, log: opts.log });
  return {
    t,
    mod,
    engine: t.rt.services.get('decisions') as DecisionEngine,
    approver: t.user('approver', 'Approver One'),
    approver2: t.user('approver', 'Approver Two'),
    builderA: t.user('builder', 'Builder A'),
    builderB: t.user('builder', 'Builder B'),
    requester: t.user('requester', 'End User'),
    requester2: t.user('requester', 'Other End User'),
  };
}

export const human = (u: TestUser): Actor => ({ kind: 'human', id: u.user.id });

export function decisionInput(
  over: Partial<DecisionRequestInput> & Pick<DecisionRequestInput, 'kind' | 'requesterId'>,
): DecisionRequestInput {
  return {
    title: 'Ship it?',
    question: 'Promote build 42?',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    recommendation: { optionId: 'approve', rationale: 'All checks are green' },
    subjectType: 'session',
    subjectId: 'ses_1',
    sessionId: 'ses_1',
    projectId: 'prj_1',
    ...over,
  };
}

/** Notifications a subscriber with `role` receives (the broadcaster filters by audience). */
export function captureNotifications(t: TestRuntime, role: Role): Notification[] {
  const got: Notification[] = [];
  t.rt.broadcaster.subscribe({
    role,
    send: (m) => {
      if (m.event === 'notification') got.push(m.data);
    },
  });
  return got;
}

/** Run a throwing call and return the error's machine code (DecisionError / HttpError). */
export function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

export function memoryLogger(): Logger & { warns: { msg: string; fields?: Record<string, unknown> }[] } {
  const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
  const log = {
    warns,
    debug() {},
    info() {},
    warn(msg: string, fields?: Record<string, unknown>) {
      warns.push({ msg, fields });
    },
    error() {},
    child() {
      return log;
    },
  };
  return log;
}
