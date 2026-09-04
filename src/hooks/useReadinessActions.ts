import { useEffect, useRef } from 'react';
import { QUESTIONS_FILE, READINESS_FILE } from '../../shared/types';
import { startReadinessFixRun, startReadinessRun } from '../lib/agentRunner';
import { preflightAuth } from '../lib/cliCheck';
import {
  applyAccepted,
  Confidence,
  confidenceFor,
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
  /** How well the product will hold up after launch. Advisory, never a gate. */
  readinessConfidence: Confidence | null;
  /** True while the check is running. */
  readinessRunning: boolean;
  /** Id of the finding being fixed right now, if any. */
  fixingFindingId: string | null;
  /** Let the agent close one finding; mvpfy re-checks to see if it worked. */
  fixFinding(id: string): Promise<boolean>;
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

  const fixFinding = (id: string) =>
    guarded(async () => {
      const finding = findings.find((f) => f.id === id);
      if (!finding) throw new Error('That finding is no longer in the report');
      if (finding.fixableBy !== 'mvpfy') {
        throw new Error('This one needs you — mvpfy cannot finish it from the code alone');
      }
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const handle = await startReadinessFixRun(project, state.settings, finding);
      runsApi.track(handle);
    });

  const checkReadiness = () =>
    guarded(async () => {
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const handle = await startReadinessRun(project, state.settings);
      runsApi.track(handle);
    });

  // A finished fix run is not a fixed finding: re-run the check and let the
  // report decide whether it is actually gone. The agent is forbidden from
  // touching the report itself, so this is the only thing that can close one.
  const rechecked = useRef(new Set<string>());
  useEffect(() => {
    for (const run of projectRuns) {
      if (run.handle.kind !== 'readiness-fix' || run.running || run.exitCode !== 0) continue;
      if (rechecked.current.has(run.handle.runId)) continue;
      rechecked.current.add(run.handle.runId);
      void checkReadiness();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRuns]);

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
    readinessConfidence: report ? confidenceFor(findings) : null,
    readinessRunning: projectRuns.some((r) => r.running && r.handle.kind === 'readiness'),
    fixingFindingId:
      projectRuns.find((r) => r.running && r.handle.kind === 'readiness-fix')?.handle.storyId ??
      null,
    fixFinding,
    checkReadiness,
    acceptFinding: (id: string) => setAccepted(id, true),
    unacceptFinding: (id: string) => setAccepted(id, false),
  };
}
