import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliAgentRunner } from './agentRun';
import { agentEnv, checkEnv } from './childEnv';
import { EngineHost, engineHostFrom, withEngine } from './engineHost';
import { applyRecipe, keepRecipe, prepareCheckout } from './prepare';
import { readGuidance } from './guidance';
import { applyLinkSettings, readLinkSettings } from './linkSettings';
import { DoctorCheck, doctorLines, fileCheck, recipeFile, runDoctor } from './doctor';
import { agentStep } from './setup';
import {
  PREVIEW_NAME,
  LinkAddresses,
  PreviewError,
  PreviewRecord,
  clearEngine,
  previewComment,
  inLinkService,
  mainServiceOf,
  recipeManifest,
  restartPreview,
  startPreview,
  stopPreview,
} from './preview';
import { validPullRequestUrl } from '../shared/runner/validate';
import { uuidFor } from './project';
import { UUID } from '../shared/runner/validate';
import { checkOutWorkspace, repositoryFolders, workspaceDir } from './workspaceCheckout';
import { planOf, readReview, reviewLine, reviewPrompt } from './review';
import { ChatRepository, ChatRequest, ChatSession, chatLine, chatTurn, chatUndo } from './chat';
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
import { Feature1ConnectionStore, readerFor, whoIs } from './feature1Connection';
import { Feature1Mcp, loadMcpAccess } from './feature1Mcp';
import { Feature1Login } from './feature1Login';
import { ProjectStore, describeProject, projectFrom } from './project';
import { PULLED_LEASE_MS, executionFor } from './pull';
import { RunnerCredentialStore, timeLeft } from './runnerCredential';
import { feature1Step, githubStep, runSetup } from './setup';
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
        mcp: {
          access: () => loadMcpAccess(secretsDirFrom()),
          whoami: (mcpUrl, token) => new Feature1Mcp(mcpUrl, token).whoami(),
        },
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
  const feature = await readerFor(connection).pullWork(
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
    if (pullRequests.length > 0) await writeReview(execution, config, redactor);
    log(
      pullRequests.length > 0
        ? 'done: built, checked and ready to review'
        : 'done: checked, and no repository needed a change'
    );
    return 0;
  }
  log(`not finished: the run ended ${state ?? 'before it started'}`);
  // Pulled work is never picked up again — the next pull is a new execution —
  // so a build that did not finish leaves nothing behind: its checkouts, with
  // their installed dependencies, were hundreds of megabytes each and filled
  // a disk. The branch stays in the clone; the checkpoint stays for reading.
  const repos = path.join(
    new Layout(config.root).executionDir(execution.tenant_id, execution.id),
    'repos'
  );
  fs.rmSync(repos, { recursive: true, force: true });
  log("removed this build's checkouts");
  return 1;
}

/**
 * What changed and what to try, for whoever reviews the build (review.ts).
 *
 * The build's branch is checked out afresh — the build's own checkouts are
 * gone by now — and the agent reads it against Feature1's plan, in the
 * sandbox, read-only. The result is printed as one REVIEW line for
 * mvpfy-cloud and kept beside the build. Best effort: whatever happens here,
 * the build is ready.
 */
async function writeReview(
  execution: ReturnType<typeof executionFor>,
  config: ReturnType<typeof configWithoutRunner>,
  redactor: Redactor
): Promise<void> {
  const root = workerRootFrom();
  const layout = new Layout(root);
  const reviewId = uuidFor(`review:${execution.id}`);
  const dir = layout.executionDir(execution.tenant_id, reviewId);
  try {
    log('writing what changed and what to try on the test link');
    const runner = new ShellRunner(redactor);
    const probe = new ShellSetupCommands();
    const github = operatorGithubToken() ?? (await ghLoginToken((c) => probe.probe(c)));
    if (github) redactor.remember(github);
    const credentials = new ExecutionCredentialSession(github);
    const git = new Git(runner, layout, process.env, credentials.git);
    const { untrusted, agentEnvironment } = await untrustedSide(runner, redactor);
    const repos = execution.repositories;
    const branch = executionBranch(execution.id);
    const changed = new Set<string>();
    credentials.begin({ repositories: repos } as never);
    let checkout: string;
    try {
      checkout = (
        await checkOutWorkspace(
          git,
          execution.tenant_id,
          repos,
          path.join(dir, 'repos'),
          async (repo) => {
            if (await git.remoteBranchExists(execution.tenant_id, repo, branch)) {
              changed.add(repo.id);
              return branch;
            }
            return repo.base_branch;
          }
        )
      ).dir;
    } finally {
      credentials.end();
    }
    const folders = repositoryFolders(repos);
    const outFile = path.join(dir, 'review.json');
    fs.rmSync(outFile, { force: true });
    const outcome = await new CliAgentRunner(untrusted, agentEnvironment).run({
      kind: config.agent,
      ...(config.agentModel ? { model: config.agentModel } : {}),
      prompt: reviewPrompt(
        planOf(execution.snapshot),
        repos.map((r) => ({
          folder: repos.length === 1 ? '.' : (folders.get(r.id) ?? r.id),
          base: r.base_branch,
          changed: changed.has(r.id),
        })),
        outFile
      ),
      cwd: checkout,
      agentDir: layout.agentDir(execution.tenant_id, reviewId),
      questionsFile: path.join(dir, 'questions.md'),
      timeoutMs: 30 * 60_000,
    });
    const review = readReview(outFile);
    if (!review) {
      log(
        `the review was not written (the agent ${outcome.timedOut ? 'ran out of time' : `exited ${outcome.code}`}); the build is ready all the same`
      );
      return;
    }
    fs.mkdirSync(path.join(root, 'reviews'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'reviews', `${execution.id}.json`),
      JSON.stringify(review, null, 2)
    );
    process.stdout.write(`${reviewLine(review)}\n`);
    log(`review: ${review.changes.length} change(s), ${review.tests.length} thing(s) to try`);
  } catch (error) {
    log(`the review could not be written: ${(error as Error).message}`);
  } finally {
    fs.rmSync(path.join(dir, 'repos'), { recursive: true, force: true });
  }
}

const CONVERSATION_ID = /^c[a-z0-9]{12}$/;

/** A test link's checkout, repository by repository, for a conversation beside it. */
async function chatContext(name: string, conversation: string) {
  if (!PREVIEW_NAME.test(name)) throw new PreviewError(`Not a preview name: ${name}`);
  if (!CONVERSATION_ID.test(conversation))
    throw new Error(`Not a conversation id: ${conversation}`);
  ensureSignInFolders();
  const { repos, tenantId, root } = projectContext();
  let record: { branch?: string };
  try {
    record = JSON.parse(fs.readFileSync(path.join(root, 'previews', `${name}.json`), 'utf8'));
  } catch {
    throw new PreviewError(`There is no test link ${name} on this runner`);
  }
  const config = configWithoutRunner(process.env);
  const redactor = new Redactor().remember(...secretsIn(config));
  const runner = new ShellRunner(redactor);
  const layout = new Layout(root);
  const probe = new ShellSetupCommands();
  const github = operatorGithubToken() ?? (await ghLoginToken((c) => probe.probe(c)));
  if (github) redactor.remember(github);
  const credentials = new ExecutionCredentialSession(github);
  credentials.begin({ repositories: repos } as never);
  const git = new Git(runner, layout, process.env, credentials.git);
  const workspace = workspaceDir(path.join(root, 'previews', name), repos);
  const folders = repositoryFolders(repos);
  const branch = record.branch ?? '';
  const chatRepos: ChatRepository[] = [];
  for (const repo of repos) {
    const dir =
      repos.length === 1 ? workspace : path.join(workspace, folders.get(repo.id) ?? repo.id);
    const onBranch =
      !!branch && (repos.length === 1 || (await git.remoteBranchExists(tenantId, repo, branch)));
    chatRepos.push({
      id: repo.id,
      name: repo.name,
      dir,
      branch: onBranch ? branch : null,
      base: repo.base_branch,
    });
  }
  const dir = path.join(root, 'conversations', name);
  fs.mkdirSync(dir, { recursive: true });
  // A product in one repository is checked inside its running main service.
  let service: string | null = null;
  if (repos.length === 1) {
    try {
      service = mainServiceOf(recipeManifest(workspace));
    } catch {
      service = null;
    }
  }
  const sessionFile = path.join(dir, `${conversation}.session.json`);
  return {
    root,
    config,
    redactor,
    runner,
    git,
    credentials,
    workspace,
    chatRepos,
    dir,
    service,
    session: {
      load: (): ChatSession | null => {
        try {
          return JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as ChatSession;
        } catch {
          return null;
        }
      },
      save: (value: ChatSession | null) =>
        value
          ? fs.writeFileSync(sessionFile, JSON.stringify(value))
          : fs.rmSync(sessionFile, { force: true }),
    },
  };
}

function chatTemplate(): string {
  return fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'prompts', 'app-chat-hosted.txt'),
    'utf8'
  );
}

/**
 * `chat <preview> <conversation>`: answer the message mvpfy-cloud left beside
 * the conversation, changing the link's checkout when it asks for a change
 * (worker/chat.ts). Prints one CHAT line.
 */
export async function chat(name: string, conversation: string): Promise<number> {
  const ctx = await chatContext(name, conversation);
  const requestFile = path.join(ctx.dir, `${conversation}.request.json`);
  let request: ChatRequest;
  try {
    request = JSON.parse(fs.readFileSync(requestFile, 'utf8')) as ChatRequest;
  } catch {
    throw new Error('There is no message waiting for this conversation');
  }
  if (typeof request.message !== 'string' || !request.message.trim())
    throw new Error('The message is empty');
  const { untrusted, agentEnvironment, checkEnvironment } = await untrustedSide(
    ctx.runner,
    ctx.redactor
  );
  const connection = new Feature1ConnectionStore(secretsDirFrom()).load();
  if (connection) ctx.redactor.remember(connection.token);
  try {
    const outcome = await chatTurn(ctx.workspace, ctx.chatRepos, request, {
      agent: new CliAgentRunner(untrusted, agentEnvironment),
      agentKind: ctx.config.agent,
      ...(ctx.config.agentModel ? { agentModel: ctx.config.agentModel } : {}),
      git: ctx.git,
      verifier: ctx.service
        ? new Verifier(
            inLinkService(untrusted, ctx.workspace, name, ctx.service),
            ctx.redactor,
            checkEnvironment,
            { install: false }
          )
        : new Verifier(untrusted, ctx.redactor, checkEnvironment),
      pullRequests: new PullRequests(ctx.runner, ctx.redactor, process.env, ctx.credentials.gh),
      note: (body) =>
        connection
          ? readerFor(connection)
              .note(connection.feature1BaseUrl, connection.token, request.code, body)
              .catch(() => false)
          : Promise.resolve(false),
      restart: () =>
        restartPreview(ctx.workspace, name, { runner: untrusted, env: checkEnvironment, log }),
      template: chatTemplate(),
      ...(readGuidance(ctx.root) ? { guidance: readGuidance(ctx.root) } : {}),
      session: ctx.session,
      agentDir: path.join(ctx.dir, 'agent'),
      questionsFile: path.join(ctx.dir, 'questions.md'),
      log,
    });
    process.stdout.write(`${chatLine('turn', outcome)}\n`);
    return outcome.error && !outcome.changed ? 1 : 0;
  } finally {
    ctx.credentials.end();
    fs.rmSync(requestFile, { force: true });
  }
}

/** `chat-undo <preview> <conversation> <commit>`: take a change made in the chat away again. */
export async function chatUndoCommand(
  name: string,
  conversation: string,
  commit: string,
  pushed = true
): Promise<number> {
  const ctx = await chatContext(name, conversation);
  try {
    const shas = commit.split(',').filter((s) => /^[0-9a-f]{7,40}$/i.test(s));
    if (shas.length === 0) throw new Error(`Not a commit: ${commit}`);
    const result = await chatUndo(
      ctx.chatRepos,
      shas,
      { git: ctx.git, restart: async () => {}, log },
      { pushed }
    );
    process.stdout.write(`${chatLine('undo', { commit, ...result })}\n`);
    return result.reverted ? 0 : 1;
  } finally {
    ctx.credentials.end();
  }
}

/**
 * `review <execution id>`: write what a finished build changed and what to
 * try, for a build made before reviews were written, or to write it again.
 */
export async function review(executionId: string): Promise<number> {
  if (!UUID.test(executionId)) throw new Error(`Not an execution id: ${executionId}`);
  ensureSignInFolders();
  const connection = new Feature1ConnectionStore(secretsDirFrom()).load();
  if (!connection) throw new Error('This runner is not signed in to Feature1. Run `setup` first.');
  const config = configWithoutRunner(process.env);
  const layout = new Layout(workerRootFrom());
  let checkpoint: { execution?: ReturnType<typeof executionFor> };
  try {
    checkpoint = JSON.parse(
      fs.readFileSync(layout.checkpointFile(uuidFor(connection.tenant.id), executionId), 'utf8')
    );
  } catch {
    throw new Error(`No build ${executionId} on this runner`);
  }
  if (!checkpoint.execution)
    throw new Error(`Build ${executionId} has no record of what it was given`);
  const redactor = new Redactor().remember(...secretsIn(config), connection.token);
  await writeReview(checkpoint.execution, config, redactor);
  return fs.existsSync(path.join(workerRootFrom(), 'reviews', `${executionId}.json`)) ? 0 : 1;
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
  const repos = target.repositories;
  const [first] = repos;
  if (!first)
    throw new Error('This runner has no repositories. Run `project <repository address>`.');
  const root = workerRootFrom();
  // One recipe per product: a repository's own id when it is the whole
  // product, as before; one id for the set when there are several.
  const key =
    repos.length === 1
      ? first.id
      : uuidFor(
          `workspace:${repos
            .map((r) => r.id)
            .sort()
            .join(',')}`
        );
  return {
    repos,
    tenantId: uuidFor(connection.tenant.id),
    root,
    recipeDir: path.join(root, 'recipes', key),
    key,
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
  const { repos, tenantId, root, recipeDir, key } = projectContext();
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
  const prepareId = uuidFor(`prepare:${key}`);
  credentials.begin({ repositories: repos } as never);
  const { dir: checkout, commits } = await checkOutWorkspace(
    git,
    tenantId,
    repos,
    path.join(layout.executionDir(tenantId, prepareId), 'repos'),
    (repo) => repo.base_branch
  );
  credentials.end();
  for (const [folder, at] of Object.entries(commits)) {
    log(`setting ${folder} up from ${at.branch} at ${at.commit.slice(0, 12)}`);
  }

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
      ...(readGuidance(root) ? { guidance: readGuidance(root) } : {}),
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
  log(`set up: ${repos.map((r) => r.name).join(', ')} can now be started for a test link`);
  return 0;
}

/**
 * `preview <branch> <name>`: start the product from a branch for a test link.
 * Prints one line of JSON — where it answers and the login — for mvpfy-cloud.
 */
export async function preview(
  branch: string,
  name: string,
  addresses?: LinkAddresses
): Promise<number> {
  if (!PREVIEW_NAME.test(name)) throw new PreviewError(`Not a preview name: ${name}`);
  ensureSignInFolders();
  const { repos, tenantId, root, recipeDir } = projectContext();
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

  credentials.begin({ repositories: repos } as never);
  // Each repository from the build's branch where the build changed it, and
  // from its base branch where it did not: a feature that touched the API
  // alone is tried against the web app as it is.
  let onBranch = 0;
  const { dir: checkout, commits } = await checkOutWorkspace(
    git,
    tenantId,
    repos,
    path.join(root, 'previews', name),
    async (repo) => {
      if (repos.length === 1 || (await git.remoteBranchExists(tenantId, repo, branch))) {
        onBranch += 1;
        return branch;
      }
      return repo.base_branch;
    }
  );
  credentials.end();
  if (onBranch === 0) throw new PreviewError(`No repository has the branch ${branch}`);
  for (const [folder, at] of Object.entries(commits)) {
    log(`${folder} from ${at.branch} at ${at.commit.slice(0, 12)}`);
  }
  const commit = Object.values(commits).find((c) => c.branch === branch)?.commit ?? '';
  applyRecipe(recipeDir, checkout);
  const settings = readLinkSettings(root);
  applyLinkSettings(path.join(checkout, '.mvpfy', '.env'), settings);
  for (const s of settings) log(`with ${s.key}=${s.value} for this link`);
  const record = await startPreview(
    checkout,
    { name, branch, commit },
    { runner: untrusted, env: checkEnvironment, engineHostname: engine.hostname, log },
    addresses
  );
  fs.writeFileSync(path.join(root, 'previews', `${name}.json`), JSON.stringify(record, null, 2));
  process.stdout.write(`PREVIEW ${JSON.stringify(record)}\n`);
  return 0;
}

/** `preview-stop <name>`: take a test link's stack away, data and all. */
export async function previewStop(name: string): Promise<number> {
  if (!PREVIEW_NAME.test(name)) throw new PreviewError(`Not a preview name: ${name}`);
  const root = workerRootFrom();
  const { repos } = projectContext();
  const redactor = new Redactor();
  const { untrusted, checkEnvironment, engine } = await untrustedSide(
    new ShellRunner(redactor),
    redactor
  );
  if (!engine) throw new PreviewError('This tenant has no Docker engine');
  const checkout = workspaceDir(path.join(root, 'previews', name), repos);
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
  const { repos } = projectContext();
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
  credentials.begin({ repositories: repos } as never);
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
 * `doctor`: whether this runner can do its job, one `CHECK` line per answer.
 * Builds nothing. Resolves with the exit code: zero when every check holds.
 */
export async function doctor(): Promise<number> {
  ensureSignInFolders();
  const root = workerRootFrom();
  const config = configWithoutRunner(process.env);
  const commands = new ShellSetupCommands();
  const redactor = new Redactor();
  const connection = new Feature1ConnectionStore(secretsDirFrom()).load();
  const target = new ProjectStore(root).load();
  const sandbox = sandboxClientFrom(process.env);
  const engine = engineHostFrom(process.env);
  const agentName = config.agent === 'claude' ? 'Claude Code' : 'Codex';

  const checks: DoctorCheck[] = [
    {
      name: 'GitHub',
      run: async () => {
        if ((await commands.probe('gh auth status --hostname github.com')).code !== 0) {
          throw new Error('Not signed in. Run setup.');
        }
        return 'Signed in';
      },
    },
    {
      name: agentName,
      run: async () => {
        // The agent's sign-in is where the agent runs: in the sandbox when
        // there is one, which is the only place it is kept.
        const where = sandbox
          ? {
              probe: async (command: string) => {
                const result = await new RemoteRunner(sandbox, redactor).run(command, {
                  cwd: root,
                  env: agentEnv(),
                  timeoutMs: 15_000,
                });
                return { code: result.code, stdout: result.stdout };
              },
              interactive: async () => null,
            }
          : commands;
        if (!(await agentStep(config.agent, where).done())) {
          throw new Error('Not signed in. Run setup.');
        }
        return sandbox ? 'Signed in, in the sandbox' : 'Signed in';
      },
    },
    {
      name: 'Feature1',
      run: async () => {
        if (!connection) throw new Error('Not signed in. Run setup.');
        redactor.remember(connection.token);
        const who = await whoIs(connection);
        return connection.via === 'mcp'
          ? `Connected to ${who.tenant.slug || who.tenant.id} through its MCP server`
          : `Signed in to ${who.tenant.slug || who.tenant.id}`;
      },
    },
    {
      name: 'Repositories',
      run: async () => {
        if (!target) throw new Error('None set. Add one in Settings.');
        return target.repositories.map((r) => `${r.name} from ${r.base_branch}`).join(', ');
      },
    },
    {
      name: 'Sandbox',
      run: async () => {
        if (!sandbox) throw new Error('This runner has no sandbox');
        await new RemoteRunner(sandbox, redactor).ready(10_000);
        return 'Answers';
      },
    },
    {
      name: 'Docker engine',
      run: async () => {
        if (!sandbox || !engine) throw new Error('This runner has no Docker engine');
        const answer = await new RemoteRunner(sandbox, redactor).run(
          "docker info --format '{{.ServerVersion}}'",
          {
            cwd: root,
            env: withEngine({ PATH: process.env.PATH ?? '' }, engine),
            timeoutMs: 15_000,
          }
        );
        if (answer.code !== 0) throw new Error(answer.stderr.trim() || 'It did not answer');
        return `Answers · Docker ${answer.stdout.trim()}`;
      },
    },
    ...(target?.repositories[0]
      ? [
          fileCheck(
            'Test links',
            recipeFile(root, target.repositories[0].id),
            'The product is set up to be started',
            'Not set up yet. Set it up from Settings.'
          ),
        ]
      : []),
  ];
  const results = await runDoctor(checks);
  for (const line of doctorLines(results)) process.stdout.write(`${line}\n`);
  return results.every((r) => r.ok) ? 0 : 1;
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
    if (command.name === 'review') process.exit(await review(command.execution));
    if (command.name === 'chat') process.exit(await chat(command.preview, command.conversation));
    if (command.name === 'chat-undo') {
      process.exit(
        await chatUndoCommand(command.preview, command.conversation, command.commit, !command.local)
      );
    }
    if (command.name === 'preview') {
      process.exit(
        await preview(
          command.branch,
          command.preview,
          command.web && command.expo ? { web: command.web, expo: command.expo } : undefined
        )
      );
    }
    if (command.name === 'preview-stop') process.exit(await previewStop(command.preview));
    if (command.name === 'comment') {
      process.exit(await comment(command.pullRequest, command.preview, command.link));
    }
    if (command.name === 'doctor') process.exit(await doctor());
    if (command.name === 'sandbox') return sandbox();
    return main();
  })();
  start.catch((error: Error) => {
    log(`worker stopped: ${error.message}`);
    process.exit(1);
  });
}
