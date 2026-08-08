import bootstrapTemplate from '../prompts/bootstrap-runtime.txt?raw';
import shipFeatureTemplate from '../prompts/ship-feature.txt?raw';
import triageTemplate from '../prompts/triage.txt?raw';
import instructTemplate from '../prompts/instruct.txt?raw';
import { AgentKind, Project, Settings } from '../../shared/types';

export type RunKind =
  | 'bootstrap'
  | 'ship'
  | 'docker-up'
  | 'docker-down'
  | 'ide-up'
  | 'ide-down'
  | 'triage'
  | 'instruct';

export interface RunHandle {
  runId: string;
  kind: RunKind;
  projectId: string;
  storyId?: string;
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
  });
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
  repoPath: string = project.repos[0]?.dir ?? project.localPath
): Promise<RunHandle> {
  const runId = makeRunId('ship');
  await window.mvpfy.runAgent({
    runId,
    repoPath,
    promptText: buildShipFeaturePrompt(repoPath, storyId),
    ...agentFor(settings),
  });
  return { runId, kind: 'ship', projectId: project.id, storyId };
}

export async function startDockerRun(project: Project, action: 'up' | 'down'): Promise<RunHandle> {
  const runId = makeRunId(`docker-${action}`);
  await window.mvpfy.dockerCompose(runId, project.localPath, action);
  return { runId, kind: action === 'up' ? 'docker-up' : 'docker-down', projectId: project.id };
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
