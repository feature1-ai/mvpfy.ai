import bootstrapTemplate from '../prompts/bootstrap-runtime.txt?raw';
import bootstrapPlanTemplate from '../prompts/bootstrap-plan.txt?raw';
import readinessTemplate from '../prompts/launch-readiness.txt?raw';
import readinessFixTemplate from '../prompts/readiness-fix.txt?raw';
import launchPlanTemplate from '../prompts/launch-plan.txt?raw';
import shipFeatureTemplate from '../prompts/ship-feature.txt?raw';
import triageTemplate from '../prompts/triage.txt?raw';
import instructTemplate from '../prompts/instruct.txt?raw';
import shipChangeTemplate from '../prompts/ship-change.txt?raw';
import planSpecTemplate from '../prompts/plan-spec.txt?raw';
import planImplementTemplate from '../prompts/plan-implement.txt?raw';
import pullFeatureTemplate from '../prompts/pull-feature.txt?raw';
import {
  AgentKind,
  BOOTSTRAP_FILE,
  ComposeAction,
  LAUNCH_FILE,
  Project,
  READINESS_FILE,
  RunAgentMcp,
  RunSession,
  Settings,
  configDirFor,
  planFileFor,
  specFileFor,
} from '../../shared/types';

/**
 * Extra ground rules injected into prompts when the workspace is the user's
 * own folder used in place rather than a managed clone: everything mvpfy
 * writes stays inside .mvpfy/ so the repository root is never polluted.
 */
const LINKED_NOTE =
  'IMPORTANT — this is a linked in-place repository (the user’s own working copy, not a ' +
  'managed clone). Every mvpfy file — mvpfy.yml, docker-compose.mvpfy.yml, env files ' +
  '(.env.mvpfy.example and the live env file), mvpfy-run.md, and every mvpfy-*.md/.json ' +
  'communication file — lives in the .mvpfy/ subfolder of the workspace root; read and ' +
  'write them THERE, never at the root. The compose file is invoked as `docker compose ' +
  '-f .mvpfy/docker-compose.mvpfy.yml --project-directory .` from the workspace root, so ' +
  'keep build contexts and host volume paths relative to the workspace root, and reference ' +
  'env files as .mvpfy/.env. If a repo needs a generated Dockerfile that does not already ' +
  'exist, write it as .mvpfy/Dockerfile.<repo> and point build.dockerfile at it; put ' +
  'generated mock services under .mvpfy/mocks/. Ensure .mvpfy/ is in .gitignore (add it if ' +
  'missing) and never commit anything under .mvpfy/.';

/**
 * What every run that edits a set-up workspace has to leave intact.
 *
 * Bootstrap states these rules to the run that creates the files; nothing
 * stated them to the runs that change them afterwards. A triage fix that moves
 * the published port leaves mvpfy looking at the old one, which presents as an
 * app that started and never answered — the failure being fixed, caused by the
 * fix. The same goes for a sign-in the product manager can no longer use.
 */
const WORKSPACE_CONTRACT =
  'THINGS THE APP DEPENDS ON — whatever else you change, leave these true:\n' +
  "• mvpfy.yml is how mvpfy finds and describes the running product. The main app's " +
  '`host_port` and the port inside its `url` must be identical to each other AND to the port ' +
  'docker-compose.mvpfy.yml actually publishes. If your change moves that port, change ' +
  "mvpfy.yml in the same edit — otherwise the product manager's app points at nothing and " +
  'their product looks like it never started.\n' +
  '• The `demo_login:` and `demo_credentials:` blocks in mvpfy.yml are how the product ' +
  'manager gets into their own product, and the app shows them those values. They must be ' +
  'credentials that actually work. If your change alters how anyone signs in — a rebuilt ' +
  'database, a new secret, a changed auth setting — re-seed that account and update the ' +
  'block. If you deliberately remove a demo account, remove the block too rather than leave ' +
  'a login on screen that no longer opens anything.\n' +
  '• Seeded demo data is what they test against. Never drop a database volume or delete ' +
  'seeded rows to make something work; if a schema genuinely has to be rebuilt, re-seed it ' +
  'afterwards.';

function workspaceNoteFor(project: Project): string {
  return project.mode === 'linked' ? LINKED_NOTE : '';
}

/**
 * Setup being run again on a project that already has generated files. Without
 * this the agent follows its reuse rule, sees a working compose file and
 * changes nothing — which is exactly the case where the PM asked for it to be
 * brought up to date.
 */
const REGENERATE_NOTE =
  'IMPORTANT — this project was set up before, and the product manager has asked for its ' +
  'setup to be REGENERATED. The mvpfy-generated files here may come from an older version ' +
  'of mvpfy: do not reuse them just because they exist and appear to work. Rewrite ' +
  'docker-compose.mvpfy.yml, any Dockerfile you generated, and mvpfy.yml to what you would ' +
  'write today, backing each up to .bak first. Keep what is still working: the same host ' +
  'ports, the same service names where you can, the same demo credentials — carry those ' +
  'values across into the env and the seed so the login already on screen keeps working — ' +
  'and the existing env file and its values. NEVER delete or recreate a database volume — the product manager ' +
  'has data in it. Their app code is not yours to change.';

/**
 * Continuing a conversation rather than starting one.
 *
 * The earlier turns are still in context, rules and all — the planning step
 * that forbade changing anything, the step that told it to write the plan
 * file it is now forbidden to touch. Saying which instructions are live is
 * the whole job of this note.
 */
const RESUME_NOTE =
  'NOTE — this continues our earlier conversation about this workspace, so you already know ' +
  'the code and the decisions behind it; use that rather than reading everything again. The ' +
  'instructions below REPLACE the ones from that earlier step: where they differ, these win, ' +
  'and any restriction you were under before no longer applies unless it is repeated here. ' +
  'The files on disk may have changed since — check anything you are about to rely on rather ' +
  'than trusting what you remember of it.';

function resumeNoteFor(session?: RunSession): string {
  return session?.resume ? RESUME_NOTE : '';
}

function regenerateNoteFor(regenerate: boolean): string {
  return regenerate ? REGENERATE_NOTE : '';
}

export type RunKind =
  | 'bootstrap-plan'
  | 'bootstrap'
  | 'readiness'
  | 'readiness-fix'
  | 'launch-plan'
  | 'ship'
  | 'docker-up'
  | 'docker-down'
  | 'ide-up'
  | 'ide-down'
  | 'triage'
  | 'instruct'
  | 'app-logs'
  | 'sync'
  | 'plan-spec'
  | 'plan-story'
  | 'raise-pr'
  | 'seed';

export interface RunHandle {
  runId: string;
  kind: RunKind;
  projectId: string;
  storyId?: string;
  /** Plan runs only: which feature's plan this run reads and writes. */
  planSlug?: string;
  /** IDE runs only: the host port code-server was asked to bind. */
  port?: number;
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  );
}

function makeRunId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function agentFor(settings: Settings): { agent: AgentKind; model?: string } {
  return settings.defaultAgent === 'codex'
    ? { agent: 'codex', model: settings.codexModel }
    : { agent: 'claude', ...(settings.claudeModel ? { model: settings.claudeModel } : {}) };
}

export function buildBootstrapPrompt(project: Project, regenerate = false): string {
  return fillTemplate(bootstrapTemplate, {
    repoPath: project.localPath,
    basePort: String(project.basePort),
    workspaceNote: workspaceNoteFor(project),
    regenerateNote: regenerateNoteFor(regenerate),
    bootstrapFile: configDirFor(project.mode) + BOOTSTRAP_FILE,
  });
}

/** Phase A of bootstrap: the task list the PM watches, written before any work. */
export function buildBootstrapPlanPrompt(project: Project, regenerate = false): string {
  return fillTemplate(bootstrapPlanTemplate, {
    repoPath: project.localPath,
    workspaceNote: workspaceNoteFor(project),
    regenerateNote: regenerateNoteFor(regenerate),
    bootstrapFile: configDirFor(project.mode) + BOOTSTRAP_FILE,
  });
}

/**
 * Read-only audit of what stands between this prototype and real users. The
 * report is the input to everything else in the launch flow.
 */
export async function startReadinessRun(project: Project, settings: Settings): Promise<RunHandle> {
  const runId = makeRunId('readiness');
  const cfg = configDirFor(project.mode);
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(readinessTemplate, {
      repoPath: project.localPath,
      workspaceNote: workspaceNoteFor(project),
      bootstrapFile: cfg + BOOTSTRAP_FILE,
      readinessFile: cfg + READINESS_FILE,
    }),
    ...agentFor(settings),
  });
  return { runId, kind: 'readiness', projectId: project.id };
}

/**
 * Work out what going live would create and cost, without touching an
 * account. The output is the cost gate the builder agrees to — or doesn't.
 */
export async function startLaunchPlanRun(
  project: Project,
  settings: Settings,
  provider: string,
  providerLabel: string,
  providerNotes: string
): Promise<RunHandle> {
  const runId = makeRunId('launch-plan');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(launchPlanTemplate, {
      repoPath: project.localPath,
      workspaceNote: workspaceNoteFor(project),
      provider,
      providerLabel,
      providerNotes,
      launchFile: configDirFor(project.mode) + LAUNCH_FILE,
    }),
    ...agentFor(settings),
  });
  return { runId, kind: 'launch-plan', projectId: project.id };
}

/**
 * Fix one readiness finding. Deliberately scoped to a single finding and
 * forbidden from touching the report: mvpfy re-runs the check afterwards, and
 * that re-check — not the agent's own say-so — is what closes the finding.
 */
export async function startReadinessFixRun(
  project: Project,
  settings: Settings,
  finding: { id: string; title: string; detail: string; fix: string; evidence: string[] }
): Promise<RunHandle> {
  const runId = makeRunId('readiness-fix');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(readinessFixTemplate, {
      contractNote: WORKSPACE_CONTRACT,
      repoPath: project.localPath,
      workspaceNote: workspaceNoteFor(project),
      title: finding.title,
      detail: finding.detail,
      fix: finding.fix,
      evidence: finding.evidence.join(', ') || '(no file recorded)',
    }),
    ...agentFor(settings),
  });
  return { runId, kind: 'readiness-fix', projectId: project.id, storyId: finding.id };
}

/**
 * Work out what setting this product up will involve and write it down as
 * cards, without changing anything. Chained straight into the bootstrap run.
 */
export async function startBootstrapPlanRun(
  project: Project,
  settings: Settings,
  regenerate = false
): Promise<RunHandle> {
  const runId = makeRunId('bootstrap-plan');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: buildBootstrapPlanPrompt(project, regenerate),
    ...agentFor(settings),
  });
  return { runId, kind: 'bootstrap-plan', projectId: project.id };
}

export function buildShipFeaturePrompt(repoPath: string, storyId: string): string {
  return fillTemplate(shipFeatureTemplate, {
    repoPath,
    storyId,
  });
}

export async function startBootstrapRun(
  project: Project,
  settings: Settings,
  regenerate = false
): Promise<RunHandle> {
  const runId = makeRunId('bootstrap');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: buildBootstrapPrompt(project, regenerate),
    ...agentFor(settings),
  });
  return { runId, kind: 'bootstrap', projectId: project.id };
}

export async function startShipFeatureRun(
  project: Project,
  storyId: string,
  settings: Settings,
  /** Which repo of the workspace to implement the story in. */
  repoPath: string = project.repos[0]?.dir ?? project.localPath,
  /** Feature1 MCP server to register with the agent, so mcp__feature1__* resolve. */
  mcp?: RunAgentMcp
): Promise<RunHandle> {
  const runId = makeRunId('ship');
  await window.mvpfy.runAgent({
    runId,
    repoPath,
    promptText: buildShipFeaturePrompt(repoPath, storyId),
    ...agentFor(settings),
    ...(mcp ? { mcp } : {}),
  });
  return { runId, kind: 'ship', projectId: project.id, storyId };
}

export async function startDockerRun(project: Project, action: ComposeAction): Promise<RunHandle> {
  const runId = makeRunId(`docker-${action}`);
  await window.mvpfy.dockerCompose(runId, project.localPath, action);
  // 'restart' counts as an up: on success the project is running. Both ways of
  // stopping land on 'docker-down', so the forceful one leaves the project in
  // the same state as the polite one.
  const stopping = action === 'down' || action === 'force-down';
  return { runId, kind: stopping ? 'docker-down' : 'docker-up', projectId: project.id };
}

/** Ship the workspace's uncommitted product changes as pull request(s). */
export async function startShipChangeRun(project: Project, settings: Settings): Promise<RunHandle> {
  const runId = makeRunId('shipchange');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(shipChangeTemplate, {
      repoPath: project.localPath,
      workspaceNote: workspaceNoteFor(project),
    }),
    ...agentFor(settings),
  });
  // Kind 'ship' so the PR URL is extracted from the run output.
  return { runId, kind: 'ship', projectId: project.id };
}

/** Generate (or refine) the minimal product spec + story plan for one feature. */
export async function startPlanSpecRun(
  project: Project,
  settings: Settings,
  planSlug: string,
  featureDescription: string,
  refinement?: string,
  session?: RunSession
): Promise<RunHandle> {
  const runId = makeRunId('planspec');
  const cfg = configDirFor(project.mode);
  const planFile = cfg + planFileFor(planSlug);
  const specFile = cfg + specFileFor(planSlug);
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(planSpecTemplate, {
      resumeNote: resumeNoteFor(session),
      repoPath: project.localPath,
      featureDescription,
      planFile,
      specFile,
      refinementBlock: refinement
        ? `A spec already exists (${specFile} / ${planFile}). Revise it per this instruction, preserving existing story codes and the lanes/prUrl/feedback of stories that survive:\n---\n${refinement}\n---`
        : '',
    }),
    ...agentFor(settings),
  });
  return { runId, kind: 'plan-spec', projectId: project.id, planSlug };
}

/**
 * Pull a Feature1 feature into this project as a native plan: the agent
 * reads the feature (PRD + stories + ACs) over the registered Feature1 MCP
 * server and writes mvpfy's own plan/spec pair, so it lands on the board
 * like a locally-planned feature. Read-only against Feature1.
 */
export async function startPullFeatureRun(
  project: Project,
  settings: Settings,
  planSlug: string,
  featureRef: string,
  mcp: RunAgentMcp,
  session?: RunSession
): Promise<RunHandle> {
  const runId = makeRunId('pullfeature');
  const cfg = configDirFor(project.mode);
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(pullFeatureTemplate, {
      resumeNote: resumeNoteFor(session),
      repoPath: project.localPath,
      featureRef,
      planFile: cfg + planFileFor(planSlug),
      specFile: cfg + specFileFor(planSlug),
    }),
    ...agentFor(settings),
    mcp,
  });
  // Reuse the plan-spec kind so the board treats this like a spec being
  // generated for the slug (the FeaturePlan.generating state keys off it).
  return { runId, kind: 'plan-spec', projectId: project.id, planSlug };
}

/**
 * When a planned story was pulled from Feature1, implementing it should also
 * drive the Feature1 workflow over MCP so its ACs and status stay in sync —
 * the same ship-feature sequence, folded into the plan-story run. Empty for
 * locally-planned stories.
 */
function feature1BlockFor(feature1StoryId?: string): string {
  if (!feature1StoryId) return '';
  return (
    'This story was planned in Feature1 (session id ' +
    feature1StoryId +
    '). The Feature1 MCP server is registered for this run, so ALSO keep Feature1 in sync ' +
    'as you implement — use its own acceptance-criteria prompts as the source of truth:\n' +
    '• Before coding: call mcp__feature1__load_workflow(session_id="' +
    feature1StoryId +
    '"), then mcp__feature1__mark_all_acs_in_progress(), then ' +
    'mcp__feature1__generate_prompts_for_all_acs() and implement to those prompts (they are ' +
    'codebase-grounded and authoritative — reconcile them with the acceptance criteria in ' +
    'the plan file).\n' +
    '• After tests pass and the PR is open: call ' +
    'mcp__feature1__mark_all_acs_implementation_done(), then ' +
    'mcp__feature1__attach_pr(pr_url="<the PR URL you just printed>"), then ' +
    'mcp__feature1__mark_ready_for_testing().\n' +
    '• If any Feature1 MCP call fails, retry once, then continue the local implementation ' +
    'and note the failure — do not abandon the code changes over a sync error.'
  );
}

/** Implement one planned story; opens/updates its PR (PR lands at Testing). */
export async function startPlanStoryRun(
  project: Project,
  settings: Settings,
  planSlug: string,
  storyCode: string,
  storyFeedback?: string | null,
  /** Feature1 story session id, when this story was pulled from Feature1. */
  feature1StoryId?: string,
  /** Feature1 MCP server to register (required when feature1StoryId is set). */
  mcp?: RunAgentMcp,
  session?: RunSession,
  /** Repo directory → this feature's checkout of it. */
  worktrees: Record<string, string> = {}
): Promise<RunHandle> {
  const runId = makeRunId('planstory');
  const checkouts = Object.entries(worktrees);
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(planImplementTemplate, {
      resumeNote: resumeNoteFor(session),
      repoPath: project.localPath,
      storyCode,
      planFile: configDirFor(project.mode) + planFileFor(planSlug),
      specFile: configDirFor(project.mode) + specFileFor(planSlug),
      // One branch per FEATURE: every story in it commits here, and the
      // feature opens a single pull request when the builder is ready.
      branchSlug: planSlug || 'feature',
      feedbackBlock: storyFeedback
        ? `The product manager tested the previous round and sent it back with this feedback — address it fully:\n---\n${storyFeedback}\n---`
        : '',
      feature1Block: feature1BlockFor(feature1StoryId),
      worktrees:
        checkouts.length > 0
          ? checkouts.map(([repo, tree]) => `   • ${repo} → ${tree}`).join('\n')
          : `   • ${project.localPath} (no separate checkout — work here)`,
    }),
    ...agentFor(settings),
    ...(mcp ? { mcp } : {}),
    ...(session ? { session } : {}),
  });
  return { runId, kind: 'plan-story', projectId: project.id, storyId: storyCode, planSlug };
}

/** Fast-forward pull each repo of the workspace from its remote. */
export async function startSyncRun(project: Project): Promise<RunHandle> {
  const runId = makeRunId('sync');
  await window.mvpfy.repoSync(
    runId,
    project.localPath,
    project.repos.map((r) => r.dir)
  );
  return { runId, kind: 'sync', projectId: project.id };
}

/** Follow the running containers' logs (docker compose logs -f). */
export async function startAppLogsRun(project: Project): Promise<RunHandle> {
  const runId = makeRunId('applogs');
  await window.mvpfy.dockerCompose(runId, project.localPath, 'logs');
  return { runId, kind: 'app-logs', projectId: project.id };
}

export async function startTriageRun(
  project: Project,
  settings: Settings,
  failedStep: string,
  logTail: string
): Promise<RunHandle> {
  const runId = makeRunId('triage');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(triageTemplate, {
      contractNote: WORKSPACE_CONTRACT,
      repoPath: project.localPath,
      failedStep,
      logTail,
      workspaceNote: workspaceNoteFor(project),
    }),
    ...agentFor(settings),
  });
  return { runId, kind: 'triage', projectId: project.id };
}

export async function startInstructRun(
  project: Project,
  settings: Settings,
  instruction: string,
  /** What is wrong with the environment, when something is. */
  trouble = ''
): Promise<RunHandle> {
  const runId = makeRunId('instruct');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(instructTemplate, {
      contractNote: WORKSPACE_CONTRACT,
      troubleNote: trouble,
      repoPath: project.localPath,
      instruction,
      workspaceNote: workspaceNoteFor(project),
    }),
    ...agentFor(settings),
  });
  return { runId, kind: 'instruct', projectId: project.id };
}

/**
 * Push the feature branch and open its pull requests.
 *
 * No agent: mvpfy works out which repositories actually changed by counting
 * commits, so nothing can misreport what it touched, and opening a pull
 * request costs no subscription time.
 */
export async function startRaisePrRun(
  project: Project,
  planSlug: string,
  branch: string,
  title: string,
  body: string
): Promise<RunHandle> {
  const runId = makeRunId('raise-pr');
  await window.mvpfy.raisePullRequests(
    runId,
    project.localPath,
    project.repos.map((r) => r.dir),
    branch,
    title,
    body
  );
  return { runId, kind: 'raise-pr', projectId: project.id, planSlug };
}

/**
 * Seed the project, once its app is answering.
 *
 * Not after `up` returns: that happens as soon as containers have started, and
 * a seed fired then would reach a database still coming up — the same race
 * that makes an app look unresponsive on a first start.
 *
 * Null when the project records no seed command, which is not a failure.
 */
export async function startSeedRun(project: Project): Promise<RunHandle | null> {
  const runId = makeRunId('seed');
  const started = await window.mvpfy.seed(runId, project.localPath);
  return started ? { runId, kind: 'seed', projectId: project.id } : null;
}

export async function startIdeRun(
  project: Project,
  action: 'up' | 'down',
  port?: number
): Promise<RunHandle> {
  const runId = makeRunId(`ide-${action}`);
  await window.mvpfy.ide(runId, project.localPath, action, port);
  return {
    runId,
    kind: action === 'up' ? 'ide-up' : 'ide-down',
    projectId: project.id,
    port,
  };
}

const PR_URL_RE =
  /https:\/\/(?:github\.com\/[^\s"'<>]+\/pull\/\d+|gitlab\.com\/[^\s"'<>]+\/-\/merge_requests\/\d+)/;

/** Find the last PR/MR URL mentioned in agent output, if any. */
export function extractPrUrl(logText: string): string | null {
  const matches = logText.match(new RegExp(PR_URL_RE, 'g'));
  return matches && matches.length > 0 ? matches[matches.length - 1] : null;
}
