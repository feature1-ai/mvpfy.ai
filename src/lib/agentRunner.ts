import bootstrapTemplate from '../prompts/bootstrap-runtime.txt?raw';
import bootstrapPlanTemplate from '../prompts/bootstrap-plan.txt?raw';
import readinessTemplate from '../prompts/launch-readiness.txt?raw';
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
  Project,
  READINESS_FILE,
  RunAgentMcp,
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

function workspaceNoteFor(project: Project): string {
  return project.mode === 'linked' ? LINKED_NOTE : '';
}

export type RunKind =
  | 'bootstrap-plan'
  | 'bootstrap'
  | 'readiness'
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
  | 'plan-story';

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
    : { agent: 'claude' };
}

export function buildBootstrapPrompt(project: Project): string {
  return fillTemplate(bootstrapTemplate, {
    repoPath: project.localPath,
    basePort: String(project.basePort),
    workspaceNote: workspaceNoteFor(project),
    bootstrapFile: configDirFor(project.mode) + BOOTSTRAP_FILE,
  });
}

/** Phase A of bootstrap: the task list the PM watches, written before any work. */
export function buildBootstrapPlanPrompt(project: Project): string {
  return fillTemplate(bootstrapPlanTemplate, {
    repoPath: project.localPath,
    workspaceNote: workspaceNoteFor(project),
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
 * Work out what setting this product up will involve and write it down as
 * cards, without changing anything. Chained straight into the bootstrap run.
 */
export async function startBootstrapPlanRun(
  project: Project,
  settings: Settings
): Promise<RunHandle> {
  const runId = makeRunId('bootstrap-plan');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: buildBootstrapPlanPrompt(project),
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

export async function startBootstrapRun(project: Project, settings: Settings): Promise<RunHandle> {
  const runId = makeRunId('bootstrap');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: buildBootstrapPrompt(project),
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

export async function startDockerRun(
  project: Project,
  action: 'up' | 'down' | 'restart' | 'logs'
): Promise<RunHandle> {
  const runId = makeRunId(`docker-${action}`);
  await window.mvpfy.dockerCompose(runId, project.localPath, action);
  // 'restart' counts as an up: on success the project is running.
  return { runId, kind: action === 'down' ? 'docker-down' : 'docker-up', projectId: project.id };
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
  refinement?: string
): Promise<RunHandle> {
  const runId = makeRunId('planspec');
  const cfg = configDirFor(project.mode);
  const planFile = cfg + planFileFor(planSlug);
  const specFile = cfg + specFileFor(planSlug);
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(planSpecTemplate, {
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
  mcp: RunAgentMcp
): Promise<RunHandle> {
  const runId = makeRunId('pullfeature');
  const cfg = configDirFor(project.mode);
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(pullFeatureTemplate, {
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
  mcp?: RunAgentMcp
): Promise<RunHandle> {
  const runId = makeRunId('planstory');
  const storyCodeSlug = storyCode.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(planImplementTemplate, {
      repoPath: project.localPath,
      storyCode,
      planFile: configDirFor(project.mode) + planFileFor(planSlug),
      specFile: configDirFor(project.mode) + specFileFor(planSlug),
      // Legacy (pre-multi-feature) plans keep their unprefixed branch names
      // so re-runs land on the branch the earlier round already pushed.
      branchSlug: planSlug ? `${planSlug}-${storyCodeSlug}` : storyCodeSlug,
      feedbackBlock: storyFeedback
        ? `The product manager tested the previous round and sent it back with this feedback — address it fully:\n---\n${storyFeedback}\n---`
        : '',
      feature1Block: feature1BlockFor(feature1StoryId),
    }),
    ...agentFor(settings),
    ...(mcp ? { mcp } : {}),
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
  instruction: string
): Promise<RunHandle> {
  const runId = makeRunId('instruct');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(instructTemplate, {
      repoPath: project.localPath,
      instruction,
      workspaceNote: workspaceNoteFor(project),
    }),
    ...agentFor(settings),
  });
  return { runId, kind: 'instruct', projectId: project.id };
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
