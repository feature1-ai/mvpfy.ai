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
  // One line, with a timestamp, to stdout. A container's logs are the only
  // place anybody will look.
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

export async function main(): Promise<void> {
  if (process.platform === 'win32') {
    // Every command is built for and run through /bin/sh. Saying so beats
    // emitting commands that silently mean something else.
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
        ...(config.runnerToken ? { runnerToken: config.runnerToken } : {}),
      });

  if (config.fake) {
    log('running against the in-process fake Feature1 — no real server is involved');
  }

  const worker = new Worker({
    transport,
    store,
    redactor,
    log,
    options: {
      name: config.name,
      workerVersion: process.env.npm_package_version ?? 'dev',
      tenantId: config.tenantId,
      concurrency: config.concurrency,
      claimIntervalMs: config.claimIntervalMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      agents: [config.agent],
    },
    makeEngine: (runnerId) =>
      new ExecutionEngine({
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
        runnerId,
        log,
      }),
  });

  await worker.register();
  const resumed = await worker.recover();
  if (resumed > 0) log(`resumed ${resumed} execution(s) left over from a previous run`);

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) {
        // The second signal: the operator is asking again, usually because
        // the container is going away regardless.
        log(`${signal} again — cancelling what is running`);
        void worker.shutdown({ force: true }).then(() => process.exit(1));
        return;
      }
      shuttingDown = true;
      log(`${signal} — draining; executions in flight will finish and report`);
      void worker.shutdown().then(() => process.exit(0));
    });
  }

  await worker.loop();
}

if (require.main === module) {
  main().catch((error: Error) => {
    log(`worker stopped: ${error.message}`);
    process.exit(1);
  });
}
