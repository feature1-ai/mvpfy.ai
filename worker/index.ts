import { CliAgentRunner } from './agentRun';
import { configFromEnv, secretsIn, workerRootFrom } from './config';
import { ExecutionCredentialSession, ghLoginToken, operatorGithubToken } from './credentials';
import { ExecutionEngine } from './engine';
import { ShellRunner } from './exec';
import { FakeFeature1 } from './fakeFeature1';
import { Git } from './git';
import { HttpFeature1Transport } from './httpTransport';
import { Layout } from './layout';
import { PullRequests } from './prs';
import { Redactor } from './redact';
import { ExecutionStore } from './store';
import { Feature1Login } from './feature1Login';
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

export async function main(): Promise<void> {
  if (process.platform === 'win32') {
    // Every command is built for and run through /bin/sh.
    throw new Error('The mvpfy worker runs on Linux or macOS, not Windows');
  }
  ensureSignInFolders();
  const saved = new RunnerCredentialStore(workerRootFrom()).load();
  const config = configFromEnv(process.env, saved);
  const redactor = new Redactor().remember(...secretsIn(config));
  const layout = new Layout(config.root);
  const store = new ExecutionStore(layout);
  const runner = new ShellRunner(redactor);

  const transport: Feature1Transport = config.fake
    ? new FakeFeature1()
    : new HttpFeature1Transport({
        baseUrl: config.feature1BaseUrl,
        runnerToken: config.runnerToken,
      });

  if (config.fake) {
    log('running against the in-process fake Feature1 — no real server is involved');
  }

  // What the claim issues wins; the operator's GH_TOKEN is what a self-hosted
  // worker falls back to when Feature1 issues nothing.
  const probe = new ShellSetupCommands();
  const github = operatorGithubToken() ?? (await ghLoginToken((command) => probe.probe(command)));
  if (github) redactor.remember(github);
  else if (!config.fake) {
    log('no GitHub sign-in found: private repositories will not clone until `setup` is run');
  }
  if (saved && !process.env.MVPFY_RUNNER_TOKEN?.trim()) {
    redactor.remember(saved.token);
    log(`using the runner credential from setup; it lasts another ${timeLeft(saved)}`);
  }
  const credentials = new ExecutionCredentialSession(github);

  const engine = new ExecutionEngine({
    transport,
    store,
    layout,
    git: new Git(runner, layout, process.env, credentials.git),
    verifier: new Verifier(runner, redactor),
    pullRequests: new PullRequests(runner, redactor, process.env, credentials.gh),
    agent: new CliAgentRunner(runner),
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
        store: new RunnerCredentialStore(workerRootFrom()),
        name: (process.env.MVPFY_WORKER_NAME ?? 'mvpfy worker').trim(),
      }),
    ],
    io
  );
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  const start = process.argv[2] === 'setup' ? setup().then((code) => process.exit(code)) : main();
  start.catch((error: Error) => {
    log(`worker stopped: ${error.message}`);
    process.exit(1);
  });
}
