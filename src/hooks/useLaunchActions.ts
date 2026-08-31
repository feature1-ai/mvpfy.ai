import { LAUNCH_FILE } from '../../shared/types';
import { startLaunchPlanRun } from '../lib/agentRunner';
import { preflightAuth } from '../lib/cliCheck';
import {
  LaunchGate,
  LaunchPlan,
  Provider,
  PROVIDER_LABELS,
  launchGate,
  monthlyTotal,
  parseLaunchPlan,
  secretsFromYou,
  LaunchSecret,
} from '../lib/launchPlan';
import { ReadinessVerdict } from '../lib/readiness';
import { ControllerContext, contentOf } from './controllerContext';

export interface LaunchActions {
  /** What going live would create, once it has been worked out. */
  launchPlan: LaunchPlan | null;
  /** The monthly estimate, totalled by mvpfy from the plan's own resources. */
  launchMonthlyUsd: number;
  /** Secrets only the builder can supply — they gate a real launch. */
  launchSecretsFromYou: LaunchSecret[];
  /** Whether mvpfy is willing to launch this at all, and why not. */
  launchGate: LaunchGate;
  launchPlanning: boolean;
  /** Work out what going live would create and cost. Spends nothing. */
  planLaunch(provider: Provider): Promise<boolean>;
}

/**
 * The launch flow's planning half: what would be created, what it would cost,
 * and whether readiness allows it at all. Nothing here provisions anything —
 * the plan is what the builder agrees to before any of that exists.
 */
export function useLaunchActions(
  ctx: ControllerContext,
  verdict: ReadinessVerdict | null
): LaunchActions {
  const { project, state, runsApi, projectRuns, pf, files, guarded } = ctx;
  const plan = parseLaunchPlan(contentOf(files, pf(LAUNCH_FILE)));

  const planLaunch = (provider: Provider) =>
    guarded(async () => {
      // The gate is enforced here, not just in the view: a product with open
      // blockers should not get a costed plan that invites a launch.
      const gate = launchGate(verdict);
      if (!gate.allowed) throw new Error(gate.reasons.join(' '));
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const handle = await startLaunchPlanRun(
        project,
        state.settings,
        provider,
        PROVIDER_LABELS[provider]
      );
      runsApi.track(handle);
    });

  return {
    launchPlan: plan,
    launchMonthlyUsd: monthlyTotal(plan),
    launchSecretsFromYou: secretsFromYou(plan),
    launchGate: launchGate(verdict),
    launchPlanning: projectRuns.some((r) => r.running && r.handle.kind === 'launch-plan'),
    planLaunch,
  };
}
