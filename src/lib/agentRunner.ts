import bootstrapTemplate from '../prompts/bootstrap-runtime.txt?raw';
import type { RunsApi } from './useRuns';
import { implementGrounding, specGrounding } from './grounding';
import { componentLibrariesFor } from './componentLibraries';
import { componentLibrariesBlock } from '../../shared/componentLibraries';
import { designLinksBlock } from '../../shared/designLinks';
import {
  LINKED_NOTE,
  REGENERATE_NOTE,
  buildSetupPrompt,
  extendNoteFor,
  fillTemplate,
} from '../../shared/setupPrompt';
import { PORT_BLOCK } from './state';
import bootstrapPlanTemplate from '../prompts/bootstrap-plan.txt?raw';
import readinessTemplate from '../prompts/launch-readiness.txt?raw';
import readinessFixTemplate from '../prompts/readiness-fix.txt?raw';
import launchPlanTemplate from '../prompts/launch-plan.txt?raw';
import shipFeatureTemplate from '../prompts/ship-feature.txt?raw';
import triageTemplate from '../prompts/triage.txt?raw';
import shipChangeTemplate from '../prompts/ship-change.txt?raw';
import planSpecTemplate from '../prompts/plan-spec.txt?raw';
import planImplementTemplate from '../prompts/plan-implement.txt?raw';
import pullFeatureTemplate from '../prompts/pull-feature.txt?raw';
import pushFeatureTemplate from '../prompts/push-feature.txt?raw';
import syncFeatureTemplate from '../prompts/sync-feature.txt?raw';
import featureChangeTemplate from '../prompts/feature-change.txt?raw';
import resolveConflictsTemplate from '../prompts/resolve-conflicts.txt?raw';
import runClientTemplate from '../prompts/run-client.txt?raw';
import installToolsTemplate from '../prompts/install-tools.txt?raw';
import appChatTemplate from '../prompts/app-chat.txt?raw';
import appChatApplyTemplate from '../prompts/app-chat-apply.txt?raw';
import {
  AgentKind,
  BOOTSTRAP_FILE,
  ComposeAction,
  LAUNCH_FILE,
  MergeConflicts,
  Project,
  READINESS_FILE,
  RunAgentMcp,
  RunSession,
  Settings,
  configDirFor,
  notesFileFor,
  planFileFor,
  specFileFor,
  QUESTIONS_FILE,
  SETUP_PROGRESS_FILE,
} from '../../shared/types';
import { SETUP_UNIT_ATTEMPTS, buildSetupUnits } from './setupUnits';

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
  | 'share'
  | 'sync'
  | 'plan-spec'
  | 'plan-story'
  | 'raise-pr'
  | 'auto-merge'
  | 'run-client'
  | 'push-feature'
  | 'sync-feature'
  | 'feature-change'
  | 'resolve-merge'
  | 'install-tools'
  | 'migrate'
  | 'seed'
  | 'git-auth'
  | 'chat';

export { codexThreadId, lostConversation } from '../../shared/agentConversation';

/**
 * Runs that are not activity.
 *
 * Most runs are a task with an end, and while one is going the buttons that
 * would start another are off. These are the other kind: they last exactly as
 * long as somebody wants them to — a log being followed, an app being shared —
 * and treating one as activity switches off the whole app for as long as it is
 * useful, which is precisely backwards.
 *
 * A set rather than a condition at each site, because the last time a run of
 * this shape was added the one place that knew the rule was not updated.
 */
export const AMBIENT_RUNS: ReadonlySet<RunKind> = new Set<RunKind>([
  'app-logs',
  'share',
  'run-client',
  // A conversation in the App tab. It does work, but it is the builder working
  // alongside everything else — one per part of the product, several at once —
  // and counting it as busy would switch the rest of the app off every time
  // somebody asked for a colour change.
  'chat',
]);

export function isAmbientRun(kind: RunKind): boolean {
  return AMBIENT_RUNS.has(kind);
}

export interface RunHandle {
  runId: string;
  kind: RunKind;
  projectId: string;
  storyId?: string;
  /** Plan runs only: which feature's plan this run reads and writes. */
  planSlug?: string;
  /** IDE runs only: the host port code-server was asked to bind. */
  port?: number;
  /** The App-tab conversation a chat run answers. */
  conversationId?: string;
}

export function makeRunId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function agentFor(
  settings: Settings,
  agent: AgentKind = settings.defaultAgent
): { agent: AgentKind; model?: string } {
  return agent === 'codex'
    ? { agent: 'codex', model: settings.codexModel }
    : { agent: 'claude', ...(settings.claudeModel ? { model: settings.claudeModel } : {}) };
}

/** The host mvpfy is running on, which the renderer only knows this way. */
export function onWindowsHost(): boolean {
  return navigator.userAgent.includes('Windows');
}

/**
 * `onWindows` is a parameter rather than read inside, because what it decides
 * — whether the generated stack polls for file changes — is worth testing
 * both ways, and a test cannot be on two operating systems.
 */
export function buildBootstrapPrompt(
  project: Project,
  regenerate = false,
  onWindows = onWindowsHost()
): string {
  return buildSetupPrompt(bootstrapTemplate, {
    project,
    regenerate,
    onWindows,
    portBlock: PORT_BLOCK,
  });
}

/** Phase A of bootstrap: the task list the PM watches, written before any work. */
export function buildBootstrapPlanPrompt(project: Project, regenerate = false): string {
  const extending = project.reposPendingSetup ?? [];
  return fillTemplate(bootstrapPlanTemplate, {
    repoPath: project.localPath,
    workspaceNote: workspaceNoteFor(project),
    regenerateNote: extending.length > 0 ? extendNoteFor(extending) : regenerateNoteFor(regenerate),
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

/**
 * Set the product up, as steps mvpfy checks one at a time (setupUnits.ts).
 *
 * Still one run as far as everything watching it is concerned. `resume`
 * carries on from the steps a previous run finished — the product manager
 * answered a question, or a diagnosis fixed something — rather than doing
 * them all again.
 */
export async function startBootstrapRun(
  project: Project,
  settings: Settings,
  regenerate = false,
  resume = false
): Promise<RunHandle> {
  const runId = makeRunId('bootstrap');
  const cfg = configDirFor(project.mode);
  await window.mvpfy.runAgentUnits({
    runId,
    repoPath: project.localPath,
    units: buildSetupUnits(project, buildBootstrapPrompt(project, regenerate)),
    maxAttempts: SETUP_UNIT_ATTEMPTS,
    questionsFile: cfg + QUESTIONS_FILE,
    progressFile: cfg + SETUP_PROGRESS_FILE,
    resume,
    shareConversation: true,
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

/**
 * Hand the pull requests to GitHub's own auto-merge, for a project with nobody
 * to review them. Raised exactly as before; what changes is that GitHub holds
 * them until their checks pass instead of a person holding them forever.
 */
export async function startAutoMergeRun(
  project: Project,
  planSlug: string,
  urls: string[]
): Promise<RunHandle> {
  const runId = makeRunId('automerge');
  await window.mvpfy.autoMergePullRequests(runId, project.localPath, urls);
  return { runId, kind: 'auto-merge', projectId: project.id, planSlug };
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
/**
 * Whether the workspace still has no product in it. Asked per run rather than
 * cached: a repository that was empty when the feature was planned holds a
 * product by the time its second story is implemented, and the instruction has
 * to change with it.
 *
 * A failure here reads as "not empty", which is the instruction mvpfy has
 * always given — so the worst case is the behaviour that shipped for months.
 */
async function groundingFor(
  project: Project,
  settings: Settings,
  kind: 'spec' | 'implement',
  notesFile?: string
) {
  let empty: boolean;
  try {
    empty = await window.mvpfy.workspaceEmpty(project.repos.map((r) => r.dir));
  } catch {
    empty = false;
  }
  const g = { empty, stack: settings.defaultStack, ...(notesFile ? { notesFile } : {}) };
  return kind === 'spec' ? specGrounding(g) : implementGrounding(g);
}

/**
 * The feature's map of the code, when the run that planned it wrote one.
 *
 * Features planned before notes existed have no such file, and must still
 * implement — so a missing one is an ordinary case, not an error, and the
 * story falls back to reading the product itself.
 */
async function notesFileFound(project: Project, planSlug: string): Promise<string | undefined> {
  const relative = configDirFor(project.mode) + notesFileFor(planSlug);
  try {
    const [file] = await window.mvpfy.readRepoFiles(project.localPath, [relative]);
    return file?.exists ? relative : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hand the tools that would not install to the coding agent.
 *
 * The one run with no project behind it: this is what happens before there is
 * a project. It needs an agent CLI to already be installed, which is exactly
 * what cannot be assumed here — the caller checks first and does not offer it
 * otherwise, because "ask the agent to install the agent" is not an answer.
 */
export async function startInstallToolsRun(
  settings: Settings,
  missing: string[],
  log: string
): Promise<RunHandle> {
  const runId = makeRunId('installtools');
  await window.mvpfy.installToolsAgent({
    runId,
    repoPath: '',
    promptText: fillTemplate(installToolsTemplate, {
      platform: onWindowsHost() ? 'Windows' : 'macOS',
      missing: missing.join(', '),
      // The tail: the reason a run failed is at the end of it, and the whole
      // log of four installers is mostly download progress.
      log: log.slice(-8000) || '(mvpfy has not run an installer yet)',
    }),
    ...agentFor(settings),
  });
  return { runId, kind: 'install-tools', projectId: '' };
}

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
  const groundingBlock = await groundingFor(project, settings, 'spec');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(planSpecTemplate, {
      groundingBlock,
      resumeNote: resumeNoteFor(session),
      repoPath: project.localPath,
      featureDescription,
      planFile,
      specFile,
      notesFile: configDirFor(project.mode) + notesFileFor(planSlug),
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
      groundingBlock: await groundingFor(project, settings, 'spec'),
      resumeNote: resumeNoteFor(session),
      repoPath: project.localPath,
      featureRef,
      planFile: cfg + planFileFor(planSlug),
      specFile: cfg + specFileFor(planSlug),
      notesFile: cfg + notesFileFor(planSlug),
    }),
    ...agentFor(settings),
    mcp,
  });
  // Reuse the plan-spec kind so the board treats this like a spec being
  // generated for the slug (the FeaturePlan.generating state keys off it).
  return { runId, kind: 'plan-spec', projectId: project.id, planSlug };
}

/**
 * The inverse of a pull: a feature planned here is filed in Feature1, PRD and
 * stories and acceptance criteria intact, and the plan records the code it was
 * given. An agent run rather than direct tool calls, because the plan has to be
 * turned into Feature1's own shape — a PRD as Markdown, stories in canonical
 * "As a … I want … so that …" form — and that is judgement, not a mapping.
 */
export async function startPushFeatureRun(
  project: Project,
  settings: Settings,
  planSlug: string,
  originalAsk: string,
  mcp: RunAgentMcp,
  session?: RunSession
): Promise<RunHandle> {
  const runId = makeRunId('pushfeature');
  const cfg = configDirFor(project.mode);
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(pushFeatureTemplate, {
      originalAsk: originalAsk.trim() || '(not recorded — this feature predates mvpfy keeping it)',
      resumeNote: resumeNoteFor(session),
      repoPath: project.localPath,
      planFile: cfg + planFileFor(planSlug),
      specFile: cfg + specFileFor(planSlug),
    }),
    ...agentFor(settings),
    mcp,
  });
  return { runId, kind: 'push-feature', projectId: project.id, planSlug };
}

/**
 * Bring an already-filed feature up to date: a refined spec, stories that have
 * moved, stories that did not exist at the first push.
 *
 * Separate from the push rather than a branch inside it, because almost nothing
 * is shared. The push creates; this one updates, must never create the feature
 * again, and has to reason about what is already on the other side — which is
 * the part a single prompt doing both would get wrong under pressure.
 */
export async function startSyncFeatureRun(
  project: Project,
  settings: Settings,
  planSlug: string,
  featureRef: string,
  originalAsk: string,
  mcp: RunAgentMcp,
  session?: RunSession
): Promise<RunHandle> {
  const runId = makeRunId('syncfeature');
  const cfg = configDirFor(project.mode);
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(syncFeatureTemplate, {
      resumeNote: resumeNoteFor(session),
      repoPath: project.localPath,
      featureRef,
      originalAsk: originalAsk.trim() || '(not recorded — this feature predates mvpfy keeping it)',
      planFile: cfg + planFileFor(planSlug),
      specFile: cfg + specFileFor(planSlug),
    }),
    ...agentFor(settings),
    mcp,
  });
  return { runId, kind: 'sync-feature', projectId: project.id, planSlug };
}

/**
 * What the feature is supposed to look like, as something the agent can open.
 *
 * Paths rather than descriptions: both CLIs can read an image off disk, and a
 * screenshot described in words is how an implementation ends up resembling
 * the description instead of the design.
 *
 * Claude Code opens them from the paths in the prompt. Codex takes them as
 * --image arguments instead, which is why the paths are also returned rather
 * than only written into the text.
 */
export async function designFor(
  project: Project,
  planSlug: string,
  design: { images: string[]; links: string[] } | undefined,
  /**
   * Decides what is said about a design made in Claude: only Claude Code can
   * open one. Required, with no default, because the whole point of
   * designLinks.ts is telling each agent the truth about what it can read —
   * a caller that forgot would tell Codex to use a tool it does not have.
   */
  agent: AgentKind
): Promise<{ block: string; imagePaths: string[] }> {
  const images = design?.images ?? [];
  const links = design?.links ?? [];
  // Asked whether or not there is a design: with none, what the product is
  // already built from is the only thing keeping the interface consistent.
  const libraries = componentLibrariesBlock(await componentLibrariesFor(project));
  if (images.length === 0 && links.length === 0) return { block: libraries, imagePaths: [] };
  let paths: string[] = [];
  if (images.length > 0) {
    paths = await window.mvpfy
      .designPaths(project.localPath, configDirFor(project.mode), planSlug, images)
      .catch(() => []);
  }
  const lines = [
    'This feature has a design. What you build must match it — it is the one part of a',
    'feature the product manager can see is wrong without being able to say why.',
  ];
  if (paths.length > 0) {
    lines.push('', 'Open each of these images before you write any interface code:');
    for (const p of paths) lines.push(`   • ${p}`);
    lines.push(
      '',
      'Follow the layout, the wording on screen, the states and the spacing as drawn.',
      'Where the design does not say, match the patterns already in this product rather',
      'than inventing something new. Where it contradicts an acceptance criterion, do what',
      'the criterion says and note the difference in your summary.'
    );
  }
  if (links.length > 0) lines.push('', designLinksBlock(links, agent));
  if (libraries) lines.push('', libraries);
  return { block: lines.join('\n'), imagePaths: paths };
}

/** True when this project lands work straight on its trunk rather than on a feature branch. */
export function isTrunkBased(project: Pick<Project, 'flow'>): boolean {
  return project.flow === 'trunk';
}

/**
 * Where a run does its work, in the prompt's own words.
 *
 * A feature-branch project works in the feature's checkouts and leaves the
 * workspace alone, because the workspace is what the builder is running. A
 * trunk-based project has no branch to keep apart: the workspace on its trunk
 * IS where the work goes, and the running app picking it up is the point.
 */
function whereBlockFor(
  project: Project,
  worktrees: Record<string, string>,
  branch: string,
  holding: string,
  step: string
): string {
  if (isTrunkBased(project)) {
    return (
      `${step}Work directly in the workspace, on each repository's default branch — this project\n` +
      `   is trunk-based: there is no feature branch and no pull request, and every commit goes\n` +
      `   straight to the trunk the whole team builds on. Before changing anything, run\n` +
      `   \`git pull --rebase --autostash\` in each repository you will touch, so you build on\n` +
      `   what is there now. Never create, switch or delete a branch.\n` +
      `   Because the trunk ships, it must keep working after every commit: a half-built part of\n` +
      `   this feature that a user could stumble on goes behind the codebase's existing feature\n` +
      `   flag mechanism if it has one, and otherwise stays unreachable until the story that\n` +
      `   completes it.`
    );
  }
  const checkouts = Object.entries(worktrees);
  const list =
    checkouts.length > 0
      ? checkouts.map(([repo, tree]) => `   • ${repo} → ${tree}`).join('\n')
      : `   • ${project.localPath} (no separate checkout — work here)`;
  return (
    `${step}Work in this feature's own checkouts, already on the branch ${branch} and already\n` +
    `   holding ${holding}:\n` +
    `${list}\n` +
    `   Read the product's code there, make every change there, and run every git command there.\n` +
    `   Never edit the product's code in ${project.localPath} — that copy is what the product manager has\n` +
    `   running, and changing it under them would swap the app they are testing.\n` +
    `   The mvpfy files named above stay in ${project.localPath}. Read them from there; do not copy\n` +
    `   them into a checkout.`
  );
}

/**
 * When a planned story was pulled from Feature1, implementing it should also
 * drive the Feature1 workflow over MCP so its ACs and status stay in sync —
 * the same ship-feature sequence, folded into the plan-story run. Empty for
 * locally-planned stories.
 */
function feature1BlockFor(feature1StoryId?: string, trunk = false): string {
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
    (trunk
      ? '• After tests pass and the commit is on the trunk: call ' +
        'mcp__feature1__mark_all_acs_implementation_done(), then ' +
        'mcp__feature1__mark_ready_for_testing(). There is no pull request to attach.\n'
      : '• After tests pass and the PR is open: call ' +
        'mcp__feature1__mark_all_acs_implementation_done(), then ' +
        'mcp__feature1__attach_pr(pr_url="<the PR URL you just printed>"), then ' +
        'mcp__feature1__mark_ready_for_testing().\n') +
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
  worktrees: Record<string, string> = {},
  /**
   * The previous attempt at this story stopped part-way — the allowance ran
   * out, or it was interrupted. Its work is still in the checkout.
   */
  continuing = false,
  design?: { images: string[]; links: string[] }
): Promise<RunHandle> {
  const runId = makeRunId('planstory');
  const trunk = isTrunkBased(project);
  const art = await designFor(project, planSlug, design, settings.defaultAgent);
  const notesFile = await notesFileFound(project, planSlug);
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(planImplementTemplate, {
      groundingBlock: await groundingFor(project, settings, 'implement', notesFile),
      resumeNote: resumeNoteFor(session),
      repoPath: project.localPath,
      storyCode,
      notesAlso: notesFile ? `, ${notesFile}` : '',
      // The one mvpfy file a story may write: a map it found to be wrong is
      // worth more corrected than left to mislead every story after it.
      notesException: notesFile
        ? ` The one exception is ${notesFile}: correct a part of it you find to be wrong.`
        : '',
      planFile: configDirFor(project.mode) + planFileFor(planSlug),
      specFile: configDirFor(project.mode) + specFileFor(planSlug),
      // One branch per FEATURE: every story in it commits here, and the
      // feature opens a single pull request when the builder is ready. A
      // trunk-based project has no branch: each story lands on the trunk.
      whereBlock: whereBlockFor(
        project,
        worktrees,
        `mvpfy/${planSlug || 'feature'}`,
        'any earlier story of this feature',
        '2. '
      ),
      shipBlock: trunk
        ? `4. Commit in each repository you changed, with the message "${storyCode}: <story title>" — the\n` +
          '   story code is how anyone reading the trunk tells this story from the rest.\n' +
          '5. Push it to the trunk: `git pull --rebase --autostash`, then `git push`. If the rebase\n' +
          '   stops on conflicts, fit the two together, run the tests again, and only push when they\n' +
          '   pass. Never force-push. Do NOT open a pull request — this project has none. Stop after\n' +
          '   pushing.'
        : `4. Commit in the checkout, with the message "${storyCode}: <story title>" — the story code is\n` +
          "   how a reviewer tells this story's work from the rest of the feature's. Push with -u.\n" +
          '5. Do NOT open a pull request. One is opened for the whole feature, by mvpfy, once the\n' +
          '   builder has tested every story in it. Stop after pushing.',
      feedbackBlock: storyFeedback
        ? `The product manager tested the previous round and sent it back with this feedback — address it fully:\n---\n${storyFeedback}\n---`
        : '',
      feature1Block: feature1BlockFor(feature1StoryId, trunk),
      designBlock: art.block,
      // Without this the run starts the story over, on top of a checkout that
      // already holds half of it — which is how the same work lands twice and
      // the two halves disagree.
      continuationBlock: continuing
        ? 'A previous attempt at this story stopped before it finished — it ran out of ' +
          'allowance, or was interrupted. Whatever it had done is still in the checkout, ' +
          'committed or not.\n' +
          'Before writing anything: read what is there. `git log` for what was committed ' +
          'against this story, and `git status` and `git diff` for what was left ' +
          'uncommitted. Work out which acceptance criteria are already met and which are ' +
          'not.\n' +
          'Then continue from there. Do not start the story again, do not revert what is ' +
          'already done, and do not duplicate it. If something half-written is wrong, ' +
          'finish it properly rather than deleting it and beginning afresh. Commit the ' +
          'uncommitted work along with the rest when the story is done.'
        : '',
    }),
    ...agentFor(settings),
    ...(mcp ? { mcp } : {}),
    ...(session ? { session } : {}),
    ...(art.imagePaths.length > 0 ? { images: art.imagePaths } : {}),
  });
  return { runId, kind: 'plan-story', projectId: project.id, storyId: storyCode, planSlug };
}

/**
 * A change to one feature's code, asked for in plain language.
 *
 * Distinct from the project-level Ask, which edits the workspace the product
 * manager is running and commits nothing: that is for the environment. This is
 * the feature's own code, so it happens in the feature's checkouts, on the
 * feature's branch, in the feature's conversation — and it commits, because a
 * change that is not on the branch is not in the pull request, and the whole
 * point is that it ships with the feature.
 *
 * It does not push and does not open a pull request. There is one of those per
 * feature and mvpfy raises it when the builder says the feature is finished.
 */
export async function startFeatureChangeRun(
  project: Project,
  settings: Settings,
  planSlug: string,
  featureName: string,
  instruction: string,
  session?: RunSession,
  worktrees: Record<string, string> = {},
  design?: { images: string[]; links: string[] }
): Promise<RunHandle> {
  const runId = makeRunId('featurechange');
  const cfg = configDirFor(project.mode);
  const art = await designFor(project, planSlug, design, settings.defaultAgent);
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(featureChangeTemplate, {
      resumeNote: resumeNoteFor(session),
      repoPath: project.localPath,
      featureName,
      instruction,
      whereBlock: whereBlockFor(
        project,
        worktrees,
        `mvpfy/${planSlug || 'feature'}`,
        'everything implemented for this feature so far',
        ''
      ).replace(/^ {3}/gm, ''),
      shipBlock: isTrunkBased(project)
        ? '3. Commit in each repository you changed, with a one-line message in plain language\n' +
          '   saying what changed — no story code, because this is not a story. Then push it to the\n' +
          '   trunk: `git pull --rebase --autostash`, then `git push`. If the rebase stops on\n' +
          '   conflicts, fit the two together and run the tests again before pushing. Never\n' +
          '   force-push, and do not open a pull request — this project has none.'
        : '3. Commit in each checkout you changed, with a one-line message in plain language saying\n' +
          '   what changed — no story code, because this is not a story. Do not push, and do not open\n' +
          "   a pull request: the feature's pull request is raised once, by mvpfy, when the product\n" +
          '   manager is finished with the whole feature.',
      designBlock: art.block,
      planFile: cfg + planFileFor(planSlug),
      specFile: cfg + specFileFor(planSlug),
    }),
    ...agentFor(settings),
    ...(session ? { session } : {}),
    ...(art.imagePaths.length > 0 ? { images: art.imagePaths } : {}),
  });
  return { runId, kind: 'feature-change', projectId: project.id, planSlug };
}

/**
 * Hand a merge that stopped on conflicts to the agent, in the feature's own
 * checkouts.
 *
 * Given to an agent rather than to the product manager because the two sides of
 * a conflict are both code, and the person who owns this screen reads plain
 * language. Given as a run of its own rather than as part of the merge because
 * what it does — rewrite files somebody else's work is in — deserves its own
 * log, and because it must be possible to finish or abandon what it leaves.
 */
export async function startResolveMergeRun(
  project: Project,
  settings: Settings,
  planSlug: string,
  featureName: string,
  trunk: string,
  conflicts: MergeConflicts[],
  session?: RunSession
): Promise<RunHandle> {
  const runId = makeRunId('resolvemerge');
  const cfg = configDirFor(project.mode);
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(resolveConflictsTemplate, {
      resumeNote: resumeNoteFor(session),
      repoPath: project.localPath,
      featureName,
      branch: `mvpfy/${planSlug || 'feature'}`,
      trunk,
      planFile: cfg + planFileFor(planSlug),
      specFile: cfg + specFileFor(planSlug),
      conflicts: conflicts
        .map(
          (c) =>
            `   • ${c.worktree}\n${c.files.map((f) => `       - ${f}`).join('\n') || '       - (nothing unmerged left)'}`
        )
        .join('\n'),
    }),
    ...agentFor(settings),
    ...(session ? { session } : {}),
  });
  return { runId, kind: 'resolve-merge', projectId: project.id, planSlug };
}

/**
 * Start a part of the product that cannot run in a container — a desktop app,
 * a phone app — using the agent already installed on this machine.
 *
 * mvpfy's environment is containers, and no container is an installed app on
 * somebody's phone. But the agent is not in a container: it is on the builder's
 * own machine with their own toolchains, which makes it the one thing here that
 * CAN open a window or start a bundler a phone connects to. Writing
 * instructions into a file and calling it handled was the alternative, and a
 * product manager is exactly the person who cannot follow them.
 *
 * Ambient: it lasts as long as the app does, like a followed log or a share.
 */
export async function startRunClientRun(
  project: Project,
  settings: Settings,
  component: { id: string; name: string; kind: string; repo?: string },
  appUrl: string,
  /** Where to run it, in the words the builder picked. */
  target = 'whatever this machine can run it on'
): Promise<RunHandle> {
  const runId = makeRunId('runclient');
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText: fillTemplate(runClientTemplate, {
      repoPath: project.localPath,
      workspaceNote: workspaceNoteFor(project),
      componentName: component.name,
      componentKind: component.kind,
      componentRepo: component.repo || project.localPath,
      appUrl,
      target,
    }),
    ...agentFor(settings),
  });
  return { runId, kind: 'run-client', projectId: project.id };
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

/**
 * One message in an App-tab conversation, sent to that part of the product's
 * own runner.
 *
 * Runs in the workspace root, not the part's repository: a change to one
 * portal often needs the env file or the compose service beside it, and the
 * agent is told which part is meant instead of being walled into it.
 */
/**
 * One message in an App-tab conversation.
 *
 * 'ask' is every message the person types: the agent reads, answers and, when
 * a change is wanted, says what it would do and asks — on a run the CLI keeps
 * read-only, so a misread request cannot reach their app. 'apply' is the run
 * their yes starts, in the same session, and the only one allowed to edit.
 */
export async function startChatRun(
  project: Project,
  settings: Settings,
  opts: {
    conversationId: string;
    mode: 'ask' | 'apply';
    /** What they typed; an apply run carries their approval instead. */
    message: string;
    agent: AgentKind;
    session?: RunSession;
    app: { id: string; name: string; kind: string; repo?: string; url?: string | null };
    trouble?: string;
  }
): Promise<RunHandle> {
  const runId = makeRunId('chat');
  const { app } = opts;
  const appNote =
    app.kind === 'project'
      ? 'This conversation is about the workspace as a whole — the environment, configuration, ' +
        'and any part of the product.'
      : `This conversation is about one part of the product: ${app.name} (${app.kind})` +
        (app.repo ? `, whose code is in ${app.repo}` : '') +
        (app.url ? `, running at ${app.url}` : '') +
        '. Keep changes to it unless the request genuinely needs something beside it, such as ' +
        'an env value or the API it calls — and say so when it does.';
  const common = {
    repoPath: project.localPath,
    workspaceNote: workspaceNoteFor(project),
    resumeNote: resumeNoteFor(opts.session),
    appNote,
    contractNote: WORKSPACE_CONTRACT,
    troubleNote: opts.trouble ?? '',
  };
  const promptText =
    opts.mode === 'ask'
      ? fillTemplate(appChatTemplate, { ...common, message: opts.message })
      : fillTemplate(appChatApplyTemplate, {
          ...common,
          // Trunk-based: a change is not done until it is on the trunk, so it
          // is committed and pushed like a story. Otherwise work reaches the
          // trunk through a feature's pull request, and a commit made here
          // would belong to no feature — so the edit stays in the workspace.
          gitBlock: isTrunkBased(project)
            ? 'This project is trunk-based: once you have changed files, the change goes straight\n' +
              'to the trunk. Stage only the files you changed, by name — never mvpfy.yml,\n' +
              'docker-compose.mvpfy.yml, .env files, mvpfy-* files, anything under mvpfy/, or a\n' +
              'secret. Commit in each repository you changed with a one-line message in plain\n' +
              'language saying what changed. Then `git pull --rebase --autostash` and `git push`.\n' +
              'If the rebase stops on conflicts, fit the two together and check it still works\n' +
              'before pushing. Never force-push, and never create, switch or delete a branch. If\n' +
              'you stopped without changing anything, commit nothing.'
            : 'Do not run git commands. The change stays in the workspace, where the product\n' +
              'manager sees it running; it reaches the trunk through a feature, not from here.',
        });
  await window.mvpfy.runAgent({
    runId,
    repoPath: project.localPath,
    promptText,
    ...agentFor(settings, opts.agent),
    ...(opts.session ? { session: opts.session } : {}),
    ...(opts.mode === 'ask' ? { readOnly: true } : {}),
  });
  return { runId, kind: 'chat', projectId: project.id, conversationId: opts.conversationId };
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
  body: string,
  runs: Pick<RunsApi, 'track' | 'fail'>
): Promise<RunHandle> {
  const runId = makeRunId('raise-pr');
  const handle: RunHandle = { runId, kind: 'raise-pr', projectId: project.id, planSlug };
  runs.track(handle);
  try {
    await window.mvpfy.raisePullRequests(
      runId,
      project.localPath,
      project.repos.map((r) => r.dir),
      branch,
      title,
      body
    );
  } catch (error) {
    runs.fail(runId, error instanceof Error ? error.message : String(error));
    throw error;
  }
  return handle;
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

/** Wire gh in as git's credential helper — the fix for a push git cannot authenticate. */
export async function startGitAuthRun(
  project: Project,
  track: (handle: RunHandle) => void
): Promise<RunHandle> {
  const runId = makeRunId('git-auth');
  const handle: RunHandle = { runId, kind: 'git-auth', projectId: project.id };
  // Listen and track before invoking IPC: a fast process may exit before the
  // invocation returns. The retry must wait for completion, not just launch.
  let finish!: (code: number | null) => void;
  const completed = new Promise<number | null>((resolve) => {
    finish = resolve;
  });
  const off = window.mvpfy.onRunExit((event) => {
    if (event.runId === runId) finish(event.code);
  });
  try {
    track(handle);
    await window.mvpfy.cliLogin(runId, 'git-auth');
    const code = await completed;
    if (code !== 0)
      throw new Error('GitHub credential setup failed. Check the Logs tab before retrying.');
    return handle;
  } finally {
    off();
  }
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
