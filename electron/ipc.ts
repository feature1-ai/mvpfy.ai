import { migrationCommandFor } from './services/migrations';
import { app, dialog, ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentKind,
  BlankProjectRemote,
  ComposeAction,
  DESIGN_IMAGE_EXTENSIONS,
  McpFetchRequest,
  MvpfyState,
  RunAgentRequest,
} from '../shared/types';
import {
  ensureDirs,
  isAllowedWorkspace,
  isLinkedPath,
  isManagedPath,
  isWorktreePath,
  TMP_DIR,
} from './paths';
import { removeQuietly, runAgent, runToolingAgent } from './services/agents';
import {
  agentModels,
  cliCheck,
  loginCommand,
  mcpAddCommand,
  signInAllCommand,
} from './services/cli';
import {
  composeCommand,
  dockerDesktopSettings,
  ensureDockerignore,
  fileSharingAdvice,
  restartServiceCommand,
  composeProgress,
  composeStatus,
  ideCommand,
  ideStatus,
  seedCommandFor,
  runningEnv,
} from './services/docker';
import { installAllCommand, installCommand, installPlans } from './services/install';
import {
  addDesignImages,
  designImagePaths,
  readDesignImage,
  removeDesignImage,
} from './services/design';
import { autoMergeCommand, pullRequestStates } from './services/github';
import { simulatorTargets } from './services/simulators';
import { hasCloudflared, tunnelCommand } from './services/share';
import { findFreePort, mcpFetch, probeUrl } from './services/net';
import {
  createBlankProject,
  addRepositories,
  createProject,
  discoverRepositories,
  deleteFeatureFiles,
  workspaceIsEmpty,
  deleteProject,
  linkProject,
  addRemoteCommand,
  readRepoBranches,
  readRepoRemotes,
  readRepoFiles,
  addWorktrees,
  checkoutFeature,
  commitFeatureWorkCommand,
  featureCheckedOut,
  featureGitStatus,
  mergeTrunkCommand,
  featureConflicts,
  finishMergeCommand,
  pushFeatureBranchCommand,
  pushTrunkCommand,
  raisePrCommand,
  removeWorktrees,
  repoSyncCommand,
  writeRepoFile,
} from './services/projects';
import { startRun, stopRun } from './services/runs';
import { runAgentUnits } from './services/agentUnits';
import { RunAgentUnitsRequest } from '../shared/agentUnits';
import { openTerminalCommand, spawnShell } from './services/shell';
import { keychainGet, keychainSet } from './services/secrets';
import { readState, writeState } from './services/store';
import { checkForUpdates, installUpdate } from './services/updates';

/** Controller layer: routes renderer IPC calls to the service modules. */
/**
 * The workspace a renderer request names, resolved — or an error saying what
 * was refused. Every handler that touches a project directory starts here:
 * the same resolve-then-guard was written out in each of them, and the one
 * that forgot it (repo file reads and writes) was the hole.
 */
function allowedWorkspace(requested: string, refusal: string): string {
  const resolved = path.resolve(requested);
  if (!isAllowedWorkspace(resolved)) throw new Error(refusal);
  return resolved;
}

/**
 * Registers every handler, each waiting on `ready` before it runs.
 *
 * `ready` is the user's environment (PATH, the login shell's variables) being
 * resolved, which used to happen with spawnSync before the window existed.
 * It now runs alongside the window opening, and anything that spawns a tool
 * waits for it here — one gate, rather than a check in each handler that
 * would be forgotten in the next one. Handlers are registered at once, so an
 * early call waits instead of failing with "no handler registered".
 */
export function registerIpc(ready: Promise<unknown> = Promise.resolve()): void {
  const handle = (
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      await ready;
      return listener(event, ...args);
    });
  };
  handle('app-version', () => app.getVersion());
  handle('cli-check', () => cliCheck());
  handle('agent-models', (_ev, agent: 'claude' | 'codex') => agentModels(agent));
  handle('read-state', () => readState());
  handle('write-state', (_ev, state: MvpfyState) => writeState(state));
  handle('keychain-get', (_ev, entry: string) => keychainGet(entry));
  handle('keychain-set', (_ev, entry: string, value: string) => keychainSet(entry, value));
  handle('open-external', (_ev, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only http(s) URLs can be opened');
    }
    return shell.openExternal(url);
  });
  handle('service-env', (_ev, workspacePath: string, linked: boolean, service: string) =>
    runningEnv(workspacePath, linked, service)
  );
  handle('add-repos', (_ev, workspacePath: string, repoUrls: string[]) =>
    addRepositories(workspacePath, repoUrls)
  );
  handle('discover-repos', (_ev, workspacePath: string, knownDirs: string[]) =>
    discoverRepositories(workspacePath, knownDirs)
  );
  handle('create-project', (_ev, repoUrls: string[], link?: boolean) =>
    link ? linkProject(repoUrls[0] ?? '') : createProject(repoUrls)
  );
  handle('create-blank-project', (_ev, name: string, remote: BlankProjectRemote) =>
    createBlankProject(name, remote)
  );
  handle('workspace-empty', (_ev, dirs: string[]) => workspaceIsEmpty(dirs));
  handle('pick-directory', async () => {
    // multiSelections: a project is often several repos side by side, so let
    // the user pick them all in one pass rather than reopening the dialog.
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections'],
      message: 'Choose one or more local git repositories',
    });
    return res.canceled ? [] : res.filePaths;
  });
  handle('delete-project', (_ev, workspacePath: string, projectKey?: string) =>
    deleteProject(workspacePath, projectKey)
  );
  handle('run-agent', (_ev, req: RunAgentRequest) => runAgent(req));
  handle('run-agent-units', (_ev, req: RunAgentUnitsRequest) => runAgentUnits(req));
  handle('stop-run', (_ev, runId: string) => stopRun(runId));
  handle('docker-compose', (_ev, runId: string, repoPath: string, action: ComposeAction) => {
    const resolved = allowedWorkspace(
      repoPath,
      'docker compose is restricted to managed and linked project directories'
    );
    const linked = isLinkedPath(resolved) && !isManagedPath(resolved);
    // Before anything builds, not at bootstrap: the compose file is rewritten
    // between runs and a repository can be added to a project later, so the
    // set of build contexts is only settled now.
    if (action === 'up' || action === 'restart' || action === 'rebuild') {
      ensureDockerignore(resolved);
    }
    startRun(runId, composeCommand(action, linked), resolved);
  });
  handle('restart-service', (_ev, runId: string, repoPath: string, service: string) => {
    const resolved = allowedWorkspace(
      repoPath,
      'docker compose is restricted to managed and linked project directories'
    );
    const linked = isLinkedPath(resolved) && !isManagedPath(resolved);
    // This one builds too (--build, so a value baked in at build time is
    // picked up), so it pays the same context cost.
    ensureDockerignore(resolved);
    startRun(runId, restartServiceCommand(service, linked), resolved);
  });
  handle(
    'ide',
    (_ev, runId: string, workspacePath: string, action: 'up' | 'down', port?: number) => {
      const resolved = allowedWorkspace(
        workspacePath,
        'IDE containers are restricted to managed and linked project directories'
      );
      startRun(runId, ideCommand(resolved, action, port), resolved);
    }
  );
  handle('migrate', (_ev, runId: string, workspacePath: string, repos: string[]) => {
    const resolved = path.resolve(workspacePath);
    if (
      !isAllowedWorkspace(resolved) ||
      !Array.isArray(repos) ||
      repos.some(
        (repo) =>
          !isAllowedWorkspace(path.resolve(repo)) ||
          (path.resolve(repo) !== resolved && !path.resolve(repo).startsWith(resolved + path.sep))
      )
    ) {
      throw new Error('Migrations are restricted to this managed or linked project.');
    }
    const linked = isLinkedPath(resolved) && !isManagedPath(resolved);
    startRun(runId, migrationCommandFor(resolved, linked, repos), resolved);
  });
  handle('seed', (_ev, runId: string, workspacePath: string) => {
    const resolved = allowedWorkspace(
      workspacePath,
      'Seeding is restricted to managed and linked project directories'
    );
    const linked = isLinkedPath(resolved) && !isManagedPath(resolved);
    const command = seedCommandFor(resolved, linked);
    if (!command) return false;
    startRun(runId, command, resolved);
    return true;
  });
  handle('compose-status', (_ev, workspacePath: string) => {
    const resolved = allowedWorkspace(
      workspacePath,
      'docker compose is restricted to managed and linked project directories'
    );
    const linked = isLinkedPath(resolved) && !isManagedPath(resolved);
    return composeStatus(resolved, linked);
  });
  handle('compose-progress', (_ev, workspacePath: string) => {
    const resolved = allowedWorkspace(
      workspacePath,
      'docker compose is restricted to managed and linked project directories'
    );
    const linked = isLinkedPath(resolved) && !isManagedPath(resolved);
    return composeProgress(resolved, linked);
  });
  // No workspace: this is about the machine, not a project. Reads another
  // application's preferences and never writes them — which switches are on is
  // the person's decision, and mvpfy's job is only to say what they cost here.
  handle('docker-advice', () => fileSharingAdvice(dockerDesktopSettings() ?? {}));
  handle('ide-status', (_ev, workspacePath: string) => {
    const resolved = allowedWorkspace(
      workspacePath,
      'IDE containers are restricted to managed and linked project directories'
    );
    return ideStatus(resolved);
  });
  handle('read-repo-files', (_ev, repoPath: string, relativePaths: string[]) =>
    readRepoFiles(repoPath, relativePaths)
  );
  handle('write-repo-file', (_ev, repoPath: string, relativePath: string, content: string) =>
    writeRepoFile(repoPath, relativePath, content)
  );
  handle('repo-branches', (_ev, dirs: string[]) => readRepoBranches(dirs));
  handle('repo-remotes', (_ev, dirs: string[]) => readRepoRemotes(dirs));
  handle('delete-feature', (_ev, workspacePath: string, configDir: string, slug: string) =>
    deleteFeatureFiles(workspacePath, configDir, slug)
  );
  handle('pr-states', (_ev, urls: string[]) => pullRequestStates(urls));
  // Read-only and local: what this machine can run a phone app on.
  handle('simulators', () => simulatorTargets());
  handle('pick-images', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      message: 'Choose the design for this feature',
      filters: [{ name: 'Images', extensions: [...DESIGN_IMAGE_EXTENSIONS] }],
    });
    return res.canceled ? [] : res.filePaths;
  });
  handle(
    'add-design',
    (_ev, workspacePath: string, configDir: string, slug: string, sources: string[]) =>
      addDesignImages(workspacePath, configDir, slug, sources)
  );
  handle(
    'remove-design',
    (_ev, workspacePath: string, configDir: string, slug: string, name: string) =>
      removeDesignImage(workspacePath, configDir, slug, name)
  );
  handle(
    'read-design',
    (_ev, workspacePath: string, configDir: string, slug: string, name: string) =>
      readDesignImage(workspacePath, configDir, slug, name)
  );
  handle(
    'design-paths',
    (_ev, workspacePath: string, configDir: string, slug: string, names: string[]) =>
      designImagePaths(workspacePath, configDir, slug, names)
  );
  handle('can-share', () => hasCloudflared());
  handle(
    'start-share',
    (_ev, runId: string, workspacePath: string, port: number, hostHeader?: string) => {
      const resolved = allowedWorkspace(
        workspacePath,
        'Sharing is restricted to managed and linked project directories'
      );
      startRun(runId, tunnelCommand(port, hostHeader ?? ''), resolved);
    }
  );
  handle('add-remote', (_ev, runId: string, workspacePath: string, dir: string, url: string) => {
    const resolved = allowedWorkspace(
      workspacePath,
      'Remotes can only be set on managed and linked project directories'
    );
    startRun(runId, addRemoteCommand(dir, url), resolved);
  });
  handle('repo-sync', (_ev, runId: string, workspacePath: string, dirs: string[]) => {
    const resolved = allowedWorkspace(
      workspacePath,
      'Sync is restricted to managed and linked project directories'
    );
    startRun(runId, repoSyncCommand(dirs), resolved);
  });
  handle(
    'feature-git-status',
    (
      _ev,
      workspacePath: string,
      dirs: string[],
      projectKey: string,
      featureSlug: string,
      branch: string
    ) => {
      allowedWorkspace(
        workspacePath,
        'Reading is restricted to managed and linked project directories'
      );
      return featureGitStatus(dirs, projectKey, featureSlug, branch);
    }
  );
  handle(
    'commit-feature-work',
    (
      _ev,
      runId: string,
      workspacePath: string,
      dirs: string[],
      projectKey: string,
      featureSlug: string,
      branch: string,
      message: string
    ) => {
      const resolved = allowedWorkspace(
        workspacePath,
        'Committing is restricted to managed and linked project directories'
      );
      const messageFile = path.join(TMP_DIR, `commit-message-${runId}.txt`);
      const command = commitFeatureWorkCommand(dirs, projectKey, featureSlug, branch, messageFile);
      fs.writeFileSync(messageFile, message, 'utf8');
      startRun(runId, command, resolved, () => removeQuietly([messageFile]));
    }
  );
  handle(
    'merge-trunk',
    (
      _ev,
      runId: string,
      workspacePath: string,
      dirs: string[],
      projectKey: string,
      featureSlug: string,
      branch: string,
      onConflict: 'abort' | 'keep'
    ) => {
      const resolved = allowedWorkspace(
        workspacePath,
        'Merge is restricted to managed and linked project directories'
      );
      const command = mergeTrunkCommand(projectKey, featureSlug, dirs, branch, onConflict);
      // Nothing to merge is not a failure — the feature may have no checkout in
      // any repository yet. Still a run, so the caller settles either way.
      startRun(
        runId,
        command || `echo ${JSON.stringify('Nothing to merge — this feature has no checkout yet.')}`,
        resolved
      );
    }
  );
  handle(
    'push-feature-branch',
    (_ev, runId: string, workspacePath: string, dirs: string[], branch: string) => {
      const resolved = allowedWorkspace(
        workspacePath,
        'Pushing is restricted to managed and linked project directories'
      );
      const command = pushFeatureBranchCommand(dirs, branch);
      startRun(
        runId,
        command ||
          `echo ${JSON.stringify(
            'Nothing to push — the remote is level with this feature, or has never seen its branch.'
          )}`,
        resolved
      );
    }
  );
  handle('push-trunk', (_ev, runId: string, workspacePath: string, dirs: string[]) => {
    const resolved = allowedWorkspace(
      workspacePath,
      'Pushing is restricted to managed and linked project directories'
    );
    const command = pushTrunkCommand(dirs);
    startRun(
      runId,
      command ||
        `echo ${JSON.stringify('Nothing to push — the remote trunk already has every commit.')}`,
      resolved
    );
  });
  handle('auto-merge-prs', (_ev, runId: string, workspacePath: string, urls: string[]) => {
    const resolved = allowedWorkspace(
      workspacePath,
      'Merging is restricted to managed and linked project directories'
    );
    const command = autoMergeCommand(urls);
    startRun(
      runId,
      command || `echo ${JSON.stringify('No pull request to arm auto-merge on.')}`,
      resolved
    );
  });
  handle(
    'feature-conflicts',
    (_ev, workspacePath: string, dirs: string[], projectKey: string, featureSlug: string) => {
      allowedWorkspace(
        workspacePath,
        'Reading is restricted to managed and linked project directories'
      );
      return featureConflicts(dirs, projectKey, featureSlug);
    }
  );
  handle(
    'finish-merge',
    (
      _ev,
      runId: string,
      workspacePath: string,
      dirs: string[],
      projectKey: string,
      featureSlug: string,
      branch: string,
      mode: 'commit' | 'abort'
    ) => {
      const resolved = allowedWorkspace(
        workspacePath,
        'Merge is restricted to managed and linked project directories'
      );
      // The guards live in the command builder, which reads git before it
      // writes anything; a refusal reaches the caller as a thrown error rather
      // than as a run that failed halfway.
      const command = finishMergeCommand(projectKey, featureSlug, dirs, branch, mode);
      startRun(
        runId,
        command || `echo ${JSON.stringify('No merge is open in this feature.')}`,
        resolved
      );
    }
  );
  handle(
    'raise-pr',
    (
      _ev,
      runId: string,
      workspacePath: string,
      dirs: string[],
      branch: string,
      title: string,
      body: string
    ) => {
      const resolved = allowedWorkspace(
        workspacePath,
        'Pull requests are restricted to managed and linked project directories'
      );
      // The body goes to disk rather than onto the command line: it is many
      // lines, and a newline inside a quoted argument ends the command on
      // cmd.exe. Built first — a raise with nothing to push throws here, and
      // then no file has been written to clean up.
      ensureDirs();
      const bodyFile = path.join(TMP_DIR, `pr-body-${runId}.md`);
      const command = raisePrCommand(dirs, branch, title, bodyFile);
      fs.writeFileSync(bodyFile, body, 'utf8');
      startRun(runId, command, resolved, () => removeQuietly([bodyFile]));
    }
  );
  handle(
    'worktree',
    (
      _ev,
      workspacePath: string,
      dirs: string[],
      projectKey: string,
      featureSlug: string,
      branch: string,
      action: 'add' | 'remove'
    ) => {
      allowedWorkspace(
        workspacePath,
        'Worktrees are restricted to managed and linked project directories'
      );
      return action === 'add'
        ? addWorktrees(projectKey, featureSlug, dirs, branch)
        : removeWorktrees(projectKey, featureSlug, dirs);
    }
  );
  handle(
    'checkout-feature',
    (_ev, workspacePath: string, dirs: string[], branch: string | null) => {
      allowedWorkspace(
        workspacePath,
        'Checkout is restricted to managed and linked project directories'
      );
      return checkoutFeature(dirs, branch);
    }
  );
  handle('feature-checked-out', (_ev, dirs: string[], branch: string) =>
    featureCheckedOut(dirs, branch)
  );
  handle('cli-login', (_ev, runId: string, tool: string) =>
    startRun(runId, loginCommand(tool), TMP_DIR)
  );
  handle('sign-in-all', (_ev, runId: string, tools: string[]) =>
    startRun(runId, signInAllCommand(tools), TMP_DIR)
  );
  handle('mcp-register', (_ev, runId: string, name: string, url: string, agent: AgentKind) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Only https MCP servers can be registered');
    ensureDirs();
    return new Promise<void>((resolve, reject) => {
      startRun(runId, mcpAddCommand(name, url, agent), TMP_DIR, (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `Could not register Feature1 in ${agent}. Check that its CLI is installed and retry.`
            )
          );
      });
    });
  });
  handle('open-terminal', (_ev, workspacePath: string) => {
    const resolved = path.resolve(workspacePath);
    // A feature's checkout is somewhere mvpfy made, under the worktrees
    // directory it owns outright — not a project directory, so the
    // workspace guard alone refused it. It is as much the builder's code as
    // the workspace is, and opening a shell in it is the point of showing
    // them where it lives.
    if (!isAllowedWorkspace(resolved) && !isWorktreePath(resolved)) {
      throw new Error('Terminals are restricted to project directories and feature checkouts');
    }
    // Detached and unwatched: it is the user's shell now, not a run of ours.
    spawnShell(openTerminalCommand(resolved), { cwd: resolved, detached: true }).unref();
  });
  handle('install-plans', () => installPlans());
  handle('install-all', (_ev, runId: string, tools: string[]) =>
    startRun(runId, installAllCommand(tools), TMP_DIR)
  );
  // Installing the tooling has no project behind it — it is what happens
  // before there is one.
  handle('install-tools-agent', (_ev, req: RunAgentRequest) => runToolingAgent(req));
  handle('install-tool', (_ev, runId: string, tool: string) =>
    startRun(runId, installCommand(tool), TMP_DIR)
  );
  handle('find-free-port', (_ev, start: number) => findFreePort(start));
  handle('probe-url', (_ev, url: string) => probeUrl(url));
  handle('mcp-fetch', (_ev, req: McpFetchRequest) => mcpFetch(req));
  handle('check-for-updates', () => checkForUpdates());
  handle('install-update', () => installUpdate());
}
