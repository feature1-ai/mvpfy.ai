import { useEffect, useRef } from 'react';
import { QUESTIONS_FILE, READINESS_FILE } from '../../shared/types';
import { startReadinessRun } from '../lib/agentRunner';
import { preflightAuth } from '../lib/cliCheck';
import {
  applyAccepted,
  parseReadiness,
  ReadinessFinding,
  ReadinessVerdict,
  verdictFor,
} from '../lib/readiness';
import { ControllerContext, contentOf } from './controllerContext';

export interface ReadinessActions {
  /** Findings from the last check, with the builder's decisions applied. */
  readinessFindings: ReadinessFinding[];
  /** What the product does, as the agent understood it. */
  readinessSummary: string | null;
  /** When the report was written (empty when the agent omitted it). */
  readinessGeneratedAt: string | null;
  /** Computed here from the findings — never taken from the agent. */
  readinessVerdict: ReadinessVerdict | null;
  /** True while the check is running. */
  readinessRunning: boolean;
  /** Read the codebase and report what stands between it and real users. */
  checkReadiness(): Promise<boolean>;
  /** "I know, and I'm launching anyway" — a decision, not a fix. */
  acceptFinding(id: string): Promise<boolean>;
  unacceptFinding(id: string): Promise<boolean>;
}

/**
 * The launch-readiness report. The agent finds and explains; mvpfy decides the
 * verdict and remembers what the builder chose to live with — an accepted
 * blocker stays a blocker, it is just one they have taken responsibility for.
 */
export function useReadinessActions(ctx: ControllerContext): ReadinessActions {
  const { project, state, updateState, runsApi, projectRuns, pf, files, guarded } = ctx;

  const report = parseReadiness(contentOf(files, pf(READINESS_FILE)));
  const findings = applyAccepted(report, project.readinessAccepted ?? []);

  const checkReadiness = () =>
    guarded(async () => {
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const handle = await startReadinessRun(project, state.settings);
      runsApi.track(handle);
    });

  // Readiness starts with the project, like everything else in setup: once
  // bootstrap has worked the product out, the check runs off the back of it.
  // It waits for bootstrap rather than starting on add because the setup's own
  // notes — which services are stand-ins, which settings are throwaway — are
  // its best evidence. Read-only, so it runs alongside the app starting up.
  const chained = useRef(new Set<string>());
  useEffect(() => {
    for (const run of projectRuns) {
      if (run.handle.kind !== 'bootstrap' || run.running || run.exitCode !== 0) continue;
      if (chained.current.has(run.handle.runId)) continue;
      // A blocked agent leaves questions and stops: the product is not set up
      // yet, so there is nothing honest to check.
      if (contentOf(files, pf(QUESTIONS_FILE))) continue;
      chained.current.add(run.handle.runId);
      void checkReadiness();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRuns]);

  const setAccepted = (id: string, accepted: boolean) =>
    guarded(async () => {
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => {
          if (p.id !== project.id) return p;
          const current = new Set(p.readinessAccepted ?? []);
          if (accepted) current.add(id);
          else current.delete(id);
          return { ...p, readinessAccepted: [...current] };
        }),
      }));
    });

  return {
    readinessFindings: findings,
    readinessSummary: report?.summary || null,
    readinessGeneratedAt: report?.generatedAt || null,
    readinessVerdict: report ? verdictFor(findings) : null,
    readinessRunning: projectRuns.some((r) => r.running && r.handle.kind === 'readiness'),
    checkReadiness,
    acceptFinding: (id: string) => setAccepted(id, true),
    unacceptFinding: (id: string) => setAccepted(id, false),
  };
}
