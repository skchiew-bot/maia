import type { AocModule } from '@aoc/kernel';
import { supervisorProjector } from './projection';
import { registerSupervisorRoutes } from './routes';
import { Supervisor, type SupervisorModuleOptions } from './supervisor';

export {
  Supervisor,
  LaunchRequestSchema,
  LaunchBodySchema,
  type SupervisorModuleOptions,
} from './supervisor';
export { SupervisorView, type SupervisedSession } from './projection';
export {
  buildClaudeArgs,
  buildHookSettings,
  buildMcpConfig,
  buildSessionEnv,
  toolPolicy,
  redactArgv,
  readCredentialProfile,
  readCredentialProfiles,
  GATEWAY_REMOTE,
  type CredentialProfile,
} from './launch-config';
export { PushGateway, serviceRepoPathFor, type PushGatewayOptions } from './push-gateway';
export { buildSystemPrompt, decisionAnswersText } from './prompts';
export { parseResetAt, isLimitNotice } from './throttle';
export { readStreamLine } from './stream';

/**
 * Launcher/supervisor module (§2, §3, §5, §10, §15). Provides the `supervisor` service; owns the session
 * lifecycle of managed sessions, resumes them on answered decisions, top-ups and throttle resets.
 */
export function createSupervisorModule(opts: SupervisorModuleOptions = {}): AocModule {
  let sup: Supervisor | null = null;
  const need = (): Supervisor => {
    if (!sup) throw new Error('supervisor module is not initialised');
    return sup;
  };
  return {
    name: 'supervisor',
    projectors: [supervisorProjector],
    reactors: [
      {
        name: 'supervisor.decision_settled',
        handles: ['decision.resolved', 'decision.withdrawn', 'decision.expired'],
        react: (e) => need().onDecisionSettled(e),
      },
      {
        name: 'supervisor.topup_granted',
        handles: ['credit.topup_granted'],
        react: (e) => need().onTopupGranted(e),
      },
    ],
    jobs: [
      { name: 'supervisor.throttle_resume', schedule: { everyMs: 30_000 }, run: () => need().throttleTick() },
    ],
    init(ctx) {
      sup = new Supervisor(ctx, opts);
      ctx.services.provide('supervisor', sup);
    },
    routes(app) {
      registerSupervisorRoutes(app, need());
    },
    start() {
      return need().recover();
    },
    // While aocd still serves: the sidecars of finished and interrupted turns send their last reports through it.
    async quiesce() {
      await sup?.shutdown();
    },
    async stop() {
      await sup?.shutdown();
    },
  };
}
