import { CliAgentRunner } from './agentRun';
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
import { Git } from './git';
import { HttpFeature1Transport } from './httpTransport';
import { Layout } from './layout';
import { PullRequests } from './prs';
import { Redactor } from './redact';
import { RemoteRunner, sandboxClientFrom } from './remoteRunner';
import { SandboxServer, sandboxServerConfigFrom } from './sandbox';
import { ExecutionStore } from './store';
import { Feature1ConnectionStore } from './feature1Connection';
import { Feature1Login } from './feature1Login';
import { Feature1Reader } from './feature1Reader';
import { ProjectStore, describeProject, projectFrom } from './project';
import { executionFor } from './pull';
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

  // Code the worker did not write — the agent, and the repositories' own
  // checks — runs in the sandbox when there is one. Git, gh and Feature1 stay
  // here, with the credentials the sandbox never sees.
  const sandbox = sandboxClientFrom(process.env);
  let untrusted: CommandRunner = runner;
  if (sandbox) {
    redactor.remember(sandbox.token);
    const remote = new RemoteRunner(sandbox, redactor);
    await remote.ready();
    untrusted = remote;
    log(`running the agent and the checks in the sandbox at ${sandbox.url}`);
  }

  const engine = new ExecutionEngine({
    transport,
    store,
    layout,
    git: new Git(runner, layout, process.env, credentials.git),
    verifier: new Verifier(untrusted, redactor),
    pullRequests: new PullRequests(runner, redactor, process.env, credentials.gh),
    agent: new CliAgentRunner(untrusted),
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
  // the same work. Pulled work is handed to nobody else, so here it only
  // ever expires by accident: a laptop asleep for longer than three minutes
  // woke to a lapsed lease and threw the agent's work away. Its clock stands
  // still, so the lease cannot run out.
  const pulledAt = Date.now();
  const feature1 = new FakeFeature1({ now: () => pulledAt });
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
    if (command.name === 'sandbox') return sandbox();
    return main();
  })();
  start.catch((error: Error) => {
    log(`worker stopped: ${error.message}`);
    process.exit(1);
  });
}
