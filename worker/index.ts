import { CliAgentRunner } from './agentRun';
import { configFromEnv, secretsIn } from './config';
import { ExecutionEngine } from './engine';
import { ShellRunner } from './exec';
import { FakeFeature1 } from './fakeFeature1';
import { Git } from './git';
import { HttpFeature1Transport } from './httpTransport';
import { Layout } from './layout';
import { PullRequests } from './prs';
import { Redactor } from './redact';
import { ExecutionStore } from './store';
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
  const config = configFromEnv();
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

  const engine = new ExecutionEngine({
    transport,
    store,
    layout,
    git: new Git(runner, layout),
    verifier: new Verifier(runner, redactor),
    pullRequests: new PullRequests(runner, redactor),
    agent: new CliAgentRunner(runner),
    redactor,
    agentKind: config.agent,
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

if (require.main === module) {
  main().catch((error: Error) => {
    log(`worker stopped: ${error.message}`);
    process.exit(1);
  });
}
