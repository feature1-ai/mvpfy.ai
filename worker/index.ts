import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliAgentRunner } from './agentRun';
import { agentEnv, checkEnv } from './childEnv';
import { EngineHost, engineHostFrom, withEngine } from './engineHost';
import { applyRecipe, keepRecipe, prepareCheckout } from './prepare';
import {
  PREVIEW_NAME,
  PreviewError,
  PreviewRecord,
  clearEngine,
  previewComment,
  startPreview,
  stopPreview,
} from './preview';
import { validPullRequestUrl } from '../shared/runner/validate';
import { uuidFor } from './project';
import {
  WorkerConfig,
  commandFrom,
  configFromEnv,
  configWithoutRunner,
  secretsDirFrom,
  secretsIn,
  workerNameFrom,
  workerRootFrom,
} from './config';
import { ExecutionCredentialSession, ghLoginToken, operatorGithubToken } from './credentials';
import { ExecutionEngine } from './engine';
import { CommandRunner, ShellRunner } from './exec';
import { FakeFeature1 } from './fakeFeature1';
import { Git, posixQuote } from './git';
import { HttpFeature1Transport } from './httpTransport';
import { Layout, executionBranch } from './layout';
import { PullRequests } from './prs';
import { Redactor } from './redact';
import { RemoteRunner, sandboxClientFrom } from './remoteRunner';
import { SandboxServer, sandboxServerConfigFrom } from './sandbox';
import { ExecutionStore } from './store';
import { Feature1ConnectionStore } from './feature1Connection';
import { Feature1Login } from './feature1Login';
import { Feature1Reader } from './feature1Reader';
import { ProjectStore, describeProject, projectFrom } from './project';
import { PULLED_LEASE_MS, executionFor } from './pull';
import { RunnerCredentialStore, timeLeft } from './runnerCredential';
import { agentStep, feature1Step, githubStep, runSetup } from './setup';
import { ShellSetupCommands, TerminalIo } from './setupIo';
import { ensureSignInFolders } from './signInFolders';
import { Feature1Transport } from './transport';
import { Verifier } from './verify';
import { Worker } from './worker';

/**
 * The headless entry point.
 *
 * `node dist-worker/worker/index.js`. No Electron, no window, no renderer —
 * the imports above are the proof, and the test beside this file is what
 * keeps it true.
 */

function log(message: string): void {
  // One line with a timestamp, to stdout. A container's logs are the only
  // place anybody will look.
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

/**
 * Where code the worker did not write runs, and with what.
 *
 * The agent, and the repositories' own checks, run in the sandbox when there
 * is one. Git, gh and Feature1 stay here, with the credentials the sandbox
 * never sees. Both get the tenant's own Docker engine when it has one, so the
 * agent can build and start the product it is working on.
 */
async function untrustedSide(
  runner: CommandRunner,
  redactor: Redactor
): Promise<{
  untrusted: CommandRunner;
  agentEnvironment: NodeJS.ProcessEnv;
  checkEnvironment: NodeJS.ProcessEnv;
  engine: EngineHost | null;
}> {
  const sandbox = sandboxClientFrom(process.env);
  let untrusted: CommandRunner = runner;
  if (sandbox) {
    redactor.remember(sandbox.token);
    const remote = new RemoteRunner(sandbox, redactor);
    await remote.ready();
    untrusted = remote;
    log(`running the agent and the checks in the sandbox at ${sandbox.url}`);
  }
  const engine = engineHostFrom(process.env);
  if (engine) log(`the sandbox has the tenant's Docker engine at ${engine.dockerHost}`);
  return {
    untrusted,
    agentEnvironment: withEngine(agentEnv(), engine),
    checkEnvironment: withEngine(checkEnv(), engine),
    engine,
  };
}

/**
 * Everything between "here is work" and "here is a pull request", put
 * together once. What differs between claiming work and pulling a feature is
 * only where the work comes from, which is the transport handed in.
 */
async function assemble(
  config: WorkerConfig,
  transport: Feature1Transport,
  redactor: Redactor
): Promise<{ worker: Worker; store: ExecutionStore }> {
  const layout = new Layout(config.root);
  const store = new ExecutionStore(layout);
  const runner = new ShellRunner(redactor);

  // What the claim issues wins; the operator's GH_TOKEN is what a self-hosted
  // worker falls back to when Feature1 issues nothing.
  const probe = new ShellSetupCommands();
  const github = operatorGithubToken() ?? (await ghLoginToken((command) => probe.probe(command)));
  if (github) redactor.remember(github);
  else if (!config.fake) {
    log('no GitHub sign-in found: private repositories will not clone until `setup` is run');
  }
  const credentials = new ExecutionCredentialSession(github);

  const { untrusted, agentEnvironment, checkEnvironment } = await untrustedSide(runner, redactor);

  const engine = new ExecutionEngine({
    transport,
    store,
    layout,
    git: new Git(runner, layout, process.env, credentials.git),
    verifier: new Verifier(untrusted, redactor, checkEnvironment),
    pullRequests: new PullRequests(runner, redactor, process.env, credentials.gh),
    agent: new CliAgentRunner(untrusted, agentEnvironment),
    redactor,
    agentKind: config.agent,
    unitAttempts: config.unitAttempts,
    credentials,
    ...(config.agentModel ? { agentModel: config.agentModel } : {}),
    log,
  });

  const worker = new Worker({
    transport,
    store,
    redactor,
    engine,
    log,
    options: {
      name: config.name,
      claimIntervalMs: config.claimIntervalMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    },
  });

  return { worker, store };
}

export async function main(): Promise<void> {
  if (process.platform === 'win32') {
    // Every command is built for and run through /bin/sh.
    throw new Error('The mvpfy worker runs on Linux or macOS, not Windows');
  }
  ensureSignInFolders();
  const saved = new RunnerCredentialStore(secretsDirFrom()).load();
  const config = configFromEnv(process.env, saved);
  const redactor = new Redactor().remember(...secretsIn(config));
  if (saved && !process.env.MVPFY_RUNNER_TOKEN?.trim()) {
    redactor.remember(saved.token);
    log(`using the runner credential from setup; it lasts another ${timeLeft(saved)}`);
  }
  const transport: Feature1Transport = config.fake
    ? new FakeFeature1()
    : new HttpFeature1Transport({
        baseUrl: config.feature1BaseUrl,
        runnerToken: config.runnerToken,
      });

  if (config.fake) {
    log('running against the in-process fake Feature1 — no real server is involved');
  }

  const { worker } = await assemble(config, transport, redactor);

  const waiting = worker.recoverable();
  if (waiting.length > 0) {
    // Not resumed directly: a lease lasts three minutes and a restart takes
    // longer, so Feature1 owns the decision and hands the run back on a
    // claim. What matters is that the checkpoint — including any pull
    // request already opened — is still here when it does.
    log(
      `${waiting.length} execution(s) left unfinished by a previous run; their checkpoints are ` +
        `kept, and Feature1 will offer them again once their leases expire`
    );
  }

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) {
        log(`${signal} again — cancelling what is running`);
        void worker.shutdown({ force: true }).then(() => process.exit(1));
        return;
      }
      shuttingDown = true;
      log(`${signal} — draining; anything in flight will finish and report`);
      void worker.shutdown().then(() => process.exit(0));
    });
  }

  log(`${config.name} is claiming work every ${Math.round(config.claimIntervalMs / 1000)}s`);
  await worker.loop();
}

/**
 * `setup`: the sign-ins this runner needs, done once and kept on its volume.
 * Resolves with the process's exit code.
 */
export async function setup(): Promise<number> {
  if (process.platform === 'win32') {
    throw new Error('The mvpfy worker runs on Linux or macOS, not Windows');
  }
  const agent = (process.env.MVPFY_AGENT ?? 'claude').trim();
  if (agent !== 'claude' && agent !== 'codex') {
    throw new Error(`MVPFY_AGENT must be claude or codex, not ${JSON.stringify(agent)}`);
  }
  ensureSignInFolders();
  const io = new TerminalIo();
  const commands = new ShellSetupCommands();
  const result = await runSetup(
    [
      githubStep(commands),
      agentStep(agent, commands),
      feature1Step({
        io,
        login: new Feature1Login(),
        store: new RunnerCredentialStore(secretsDirFrom()),
        connections: new Feature1ConnectionStore(secretsDirFrom()),
        name: workerNameFrom(),
      }),
    ],
    io
  );
  return result.ok ? 0 : 1;
}

/**
 * `project`: say which repositories this runner builds, or show what it was told.
 */
export function project(repositories: string[]): number {
  const store = new ProjectStore(workerRootFrom());
  if (repositories.length > 0) store.save(projectFrom(repositories));
  const current = store.load();
  if (!current) {
    process.stdout.write(
      'This runner has not been told what it builds.\n' +
        'Say so with: project <repository address>[#branch] …\n'
    );
    return 1;
  }
  process.stdout.write(`This runner builds:\n${describeProject(current)}\n`);
  return 0;
}

/**
 * `implement <feature>`: pull one feature from Feature1 and build it, the way
 * the desktop app does for the person at it. Resolves with the exit code:
 * zero when every repository has a pull request or needed no change.
 *
 * The work comes from this process instead of from Feature1's queue, and that
 * is the only difference. It is offered to an in-process copy of Feature1's
 * own rules (fakeFeature1.ts), so the engine is held to the same checks —
 * passing results for every repository before anything is called ready — as
 * when the real server is the one asking.
 */
/** Written by `implement` when a build is ready, on the worker's volume. */
export const LAST_BUILD_FILE = 'last-build.json';

export async function implement(reference: string): Promise<number> {
  if (process.platform === 'win32') {
    throw new Error('The mvpfy worker runs on Linux or macOS, not Windows');
  }
  ensureSignInFolders();
  const connection = new Feature1ConnectionStore(secretsDirFrom()).load();
  if (!connection) {
    throw new Error('This runner is not signed in to Feature1. Run `setup` first.');
  }
  const target = new ProjectStore(workerRootFrom()).load();
  if (!target) {
    throw new Error(
      'This runner has not been told what it builds. Run `project <repository address>` first.'
    );
  }
  const config = configWithoutRunner(process.env);
  const redactor = new Redactor().remember(...secretsIn(config), connection.token);

  log(`pulling ${reference} from ${connection.feature1BaseUrl}`);
  const feature = await new Feature1Reader().pullFeature(
    connection.feature1BaseUrl,
    connection.token,
    reference
  );
  const execution = executionFor(feature, target, {
    tenantId: connection.tenant.id,
    userId: connection.user.id,
  });
  const done = feature.finished.length;
  log(
    `"${feature.title}"${feature.code ? ` (${feature.code})` : ''}: ` +
      `${feature.stories.length} to build${done ? `, ${done} already finished` : ''}`
  );
  for (const story of feature.stories) {
    log(`  • ${story.code ? `${story.code} ` : ''}${story.title}`);
  }
  log(`in:\n${describeProject(target)}`);

  // The lease fences one worker off from another that Feature1 has handed
  // the same work. Pulled work is handed to nobody else, so here a lease only
  // ever runs out by accident — a laptop asleep for longer than three
  // minutes woke to a lapsed one and threw the agent's work away. So it is
  // given one longer than any build, on the real clock: the engine compares
  // the lease's end against the time itself before it publishes, which is
  // why a frozen clock was not enough.
  const feature1 = new FakeFeature1({ leaseMs: PULLED_LEASE_MS });
  feature1.offer(execution);
  const { worker } = await assemble(config, feature1, redactor);

  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(1);
      stopping = true;
      log(`${signal} — cancelling; again to stop at once`);
      worker.cancel();
    });
  }

  await worker.tick();

  const state = feature1.stateOf(execution.id);
  const message = [...feature1.progressCalls].reverse().find((call) => call.body.message)
    ?.body.message;
  const pullRequests = Object.values(feature1.resultsOf(execution.id)).flatMap((r) => r.pr_urls);
  if (message) log(message);
  for (const url of pullRequests) log(`pull request: ${url}`);
  if (state === 'ready_for_testing') {
    // What mvpfy-cloud starts a test link from: the branch this build pushed.
    fs.writeFileSync(
      path.join(workerRootFrom(), LAST_BUILD_FILE),
      JSON.stringify(
        {
          feature: feature.code ?? feature.id,
          branch: executionBranch(execution.id),
          pullRequests,
          finishedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
    log(
      pullRequests.length > 0
        ? 'done: built, checked and ready to review'
        : 'done: checked, and no repository needed a change'
    );
    return 0;
  }
  log(`not finished: the run ended ${state ?? 'before it started'}`);
  return 1;
}

/**
 * What `prepare` and `preview` need of a pulled-work runner: who it is signed
 * in as, the one repository it builds, and a place under its root for each.
 */
function projectContext() {
  const connection = new Feature1ConnectionStore(secretsDirFrom()).load();
  if (!connection) throw new Error('This runner is not signed in to Feature1. Run `setup` first.');
  const target = new ProjectStore(workerRootFrom()).load();
  if (!target) {
    throw new Error(
      'This runner has not been told what it builds. Run `project <repository address>` first.'
    );
  }
  const [repo, ...others] = target.repositories;
  if (!repo || others.length > 0) {
    // Setup can span several repositories; starting one for a test link
    // across several is not built yet.
    throw new Error('Test links work for a project of one repository for now');
  }
  const root = workerRootFrom();
  return {
    repo,
    tenantId: uuidFor(connection.tenant.id),
    root,
    recipeDir: path.join(root, 'recipes', repo.id),
  };
}

function setupTemplate(): string {
  // Shipped beside the worker by Dockerfile.worker, and in the repository
  // at the same place relative to the compiled code.
  const file = path.join(__dirname, '..', '..', 'src', 'prompts', 'bootstrap-runtime.txt');
  return fs.readFileSync(file, 'utf8');
}

/**
 * `prepare`: set the product up once, the way the desktop app does, so it can
 * be started for a test link. Resolves with the exit code.
 */
export async function prepare(): Promise<number> {
  ensureSignInFolders();
  const { repo, tenantId, root, recipeDir } = projectContext();
  const config = configWithoutRunner(process.env);
  const redactor = new Redactor().remember(...secretsIn(config));
  const runner = new ShellRunner(redactor);
  const layout = new Layout(root);
  const probe = new ShellSetupCommands();
  const github = operatorGithubToken() ?? (await ghLoginToken((c) => probe.probe(c)));
  if (github) redactor.remember(github);
  const credentials = new ExecutionCredentialSession(github);
  const git = new Git(runner, layout, process.env, credentials.git);
  const { untrusted, agentEnvironment, checkEnvironment, engine } = await untrustedSide(
    runner,
    redactor
  );
  if (!engine) log('no Docker engine for this tenant: the stack cannot be checked as it is set up');

  // A worktree like any execution's, under an id of its own, so it lives
  // where the sandbox and the engine both see it.
  const prepareId = uuidFor(`prepare:${repo.id}`);
  credentials.begin({ repositories: [repo] } as never);
  const checkout = path.join(layout.executionDir(tenantId, prepareId), 'repos', repo.id);
  const commit = await git.detachedCheckout(tenantId, repo, repo.base_branch, checkout);
  credentials.end();
  log(`setting ${repo.name} up from ${repo.base_branch} at ${commit.slice(0, 12)}`);

  const outcome = await prepareCheckout(
    checkout,
    layout.agentDir(tenantId, prepareId),
    path.join(recipeDir + '.progress.json'),
    {
      agent: new CliAgentRunner(untrusted, agentEnvironment),
      checks: untrusted,
      checkEnv: checkEnvironment,
      agentKind: config.agent,
      ...(config.agentModel ? { agentModel: config.agentModel } : {}),
      template: setupTemplate(),
      log,
    }
  );
  if (outcome.kind === 'questions') {
    log('setup stopped to ask:');
    for (const question of outcome.questions) log(`  • ${question}`);
    return 1;
  }
  if (outcome.kind === 'failed') {
    log(`setup did not finish at "${outcome.step}": ${outcome.reason}`);
    return 1;
  }
  keepRecipe(checkout, recipeDir);
  // What setup started to check its work is not a test link, and would hold its ports.
  if (engine) {
    await clearEngine({ runner: untrusted, env: checkEnvironment, log }, checkout);
  }
  fs.rmSync(recipeDir + '.progress.json', { force: true });
  log(`set up: ${repo.name} can now be started for a test link`);
  return 0;
}

/**
 * `preview <branch> <name>`: start the product from a branch for a test link.
 * Prints one line of JSON — where it answers and the login — for mvpfy-cloud.
 */
export async function preview(branch: string, name: string): Promise<number> {
  if (!PREVIEW_NAME.test(name)) throw new PreviewError(`Not a preview name: ${name}`);
  ensureSignInFolders();
  const { repo, tenantId, root, recipeDir } = projectContext();
  const redactor = new Redactor().remember(...secretsIn(configWithoutRunner(process.env)));
  const runner = new ShellRunner(redactor);
  const layout = new Layout(root);
  const probe = new ShellSetupCommands();
  const github = operatorGithubToken() ?? (await ghLoginToken((c) => probe.probe(c)));
  if (github) redactor.remember(github);
  const credentials = new ExecutionCredentialSession(github);
  const git = new Git(runner, layout, process.env, credentials.git);
  const { untrusted, checkEnvironment, engine } = await untrustedSide(runner, redactor);
  if (!engine) throw new PreviewError('This tenant has no Docker engine to start the product in');

  const checkout = path.join(root, 'previews', name, repo.id);
  credentials.begin({ repositories: [repo] } as never);
  const commit = await git.detachedCheckout(tenantId, repo, branch, checkout);
  credentials.end();
  applyRecipe(recipeDir, checkout);
  const record = await startPreview(
    checkout,
    { name, branch, commit },
    { runner: untrusted, env: checkEnvironment, engineHostname: engine.hostname, log }
  );
  fs.writeFileSync(path.join(root, 'previews', `${name}.json`), JSON.stringify(record, null, 2));
  process.stdout.write(`PREVIEW ${JSON.stringify(record)}\n`);
  return 0;
}

/** `preview-stop <name>`: take a test link's stack away, data and all. */
export async function previewStop(name: string): Promise<number> {
  if (!PREVIEW_NAME.test(name)) throw new PreviewError(`Not a preview name: ${name}`);
  const root = workerRootFrom();
  const { repo } = projectContext();
  const redactor = new Redactor();
  const { untrusted, checkEnvironment, engine } = await untrustedSide(
    new ShellRunner(redactor),
    redactor
  );
  if (!engine) throw new PreviewError('This tenant has no Docker engine');
  const checkout = path.join(root, 'previews', name, repo.id);
  await stopPreview(checkout, name, { runner: untrusted, env: checkEnvironment, log });
  fs.rmSync(path.join(root, 'previews', name), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'previews', `${name}.json`), { force: true });
  log(`stopped ${name}`);
  return 0;
}

/**
 * `comment <pull request> <preview name> <link>`: say on the pull request
 * where it can be tried, with the worker's own GitHub sign-in.
 */
export async function comment(pullRequest: string, name: string, link: string): Promise<number> {
  if (!validPullRequestUrl(pullRequest)) throw new Error(`Not a pull request: ${pullRequest}`);
  if (!PREVIEW_NAME.test(name)) throw new PreviewError(`Not a preview name: ${name}`);
  if (!/^https?:\/\/p[a-z0-9]{12}\.[a-z0-9.-]+(:\d{2,5})?\/?$/.test(link)) {
    throw new Error(`Not a test link: ${link}`);
  }
  const { repo } = projectContext();
  const root = workerRootFrom();
  const record = JSON.parse(
    fs.readFileSync(path.join(root, 'previews', `${name}.json`), 'utf8')
  ) as PreviewRecord;
  const redactor = new Redactor();
  const probe = new ShellSetupCommands();
  const github = operatorGithubToken() ?? (await ghLoginToken((c) => probe.probe(c)));
  if (!github) throw new Error('No GitHub sign-in to comment with. Run `setup`.');
  redactor.remember(github);
  const credentials = new ExecutionCredentialSession(github);
  credentials.begin({ repositories: [repo] } as never);
  const bodyFile = path.join(root, 'previews', `${name}.comment.md`);
  fs.writeFileSync(bodyFile, previewComment(record, link));
  try {
    const result = await new ShellRunner(redactor).run(
      `gh pr comment ${posixQuote(pullRequest)} --body-file ${posixQuote(bodyFile)}`,
      { cwd: root, env: credentials.gh.apply({ ...process.env, GH_PROMPT_DISABLED: '1' }) }
    );
    if (result.code !== 0) throw new Error(`Could not comment: ${result.stderr.trim()}`);
  } finally {
    credentials.end();
    fs.rmSync(bodyFile, { force: true });
  }
  log(`said on ${pullRequest} where to try it`);
  return 0;
}

/**
 * `sandbox`: run what a worker sends, and hold nothing of the worker's.
 * See sandbox.ts for why this is a separate container.
 */
export async function sandbox(): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error('The mvpfy worker runs on Linux or macOS, not Windows');
  }
  ensureSignInFolders();
  const config = sandboxServerConfigFrom(process.env, workerRootFrom());
  const server = new SandboxServer(config, new ShellRunner(), log);
  const port = await server.listen();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log(`${signal} — cancelling what is running and stopping`);
      void server.close().then(() => process.exit(0));
    });
  }
  log(`sandbox is taking commands on port ${port}, for work under ${config.root}`);
}

if (require.main === module) {
  const start = (async () => {
    const command = commandFrom(process.argv);
    if (command.name === 'setup') process.exit(await setup());
    if (command.name === 'project') process.exit(project(command.repositories));
    if (command.name === 'implement') process.exit(await implement(command.feature));
    if (command.name === 'prepare') process.exit(await prepare());
    if (command.name === 'preview') process.exit(await preview(command.branch, command.preview));
    if (command.name === 'preview-stop') process.exit(await previewStop(command.preview));
    if (command.name === 'comment') {
      process.exit(await comment(command.pullRequest, command.preview, command.link));
    }
    if (command.name === 'sandbox') return sandbox();
    return main();
  })();
  start.catch((error: Error) => {
    log(`worker stopped: ${error.message}`);
    process.exit(1);
  });
}
