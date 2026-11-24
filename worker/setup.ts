import { AgentKind } from './agentRun';
import { Feature1Identity, MintedRunner, workspaceBaseUrl } from './feature1Login';
import { SavedRunner, isExpired, timeLeft } from './runnerCredential';

/**
 * Setting a runner up: the sign-ins it cannot work without, done once.
 *
 * `node dist-worker/worker/index.js setup`. It is the desktop app's
 * onboarding, for a machine with no window: GitHub through `gh`, the coding
 * agent through its own sign-in, and Feature1 with a workspace address and a
 * personal token. Each prints a code and an address to open on any other
 * device, so the runner itself needs no browser.
 *
 * Every step is the same three moves, and they are kept apart for the same
 * reason the checks in unitRunner.ts are: a sign-in command that exits zero
 * has not proved anyone is signed in. So a step is asked whether it is
 * already done, does its work only if not, and is then asked again — and
 * that second answer, not the command's, is what setup reports.
 *
 * Steps are a list handed in. Adding one — a second agent, a registry
 * login — is writing a step and adding it to the list in index.ts.
 */

/** Talking to whoever is running setup. */
export interface SetupIo {
  say(text: string): void;
  ask(question: string, options?: { secret?: boolean }): Promise<string>;
}

/** Running the sign-in commands. */
export interface SetupCommands {
  /** Quietly, to learn something. */
  probe(command: string): Promise<{ code: number | null; stdout: string }>;
  /** Attached to the terminal, so the person can read the code and answer. */
  interactive(command: string): Promise<number | null>;
}

export interface SetupStep {
  id: string;
  title: string;
  /** Is this already in place? Evidence, never a remembered flag. */
  done(): Promise<boolean>;
  /** Do it. May throw with a message for the person. */
  perform(): Promise<void>;
}

export interface SetupResult {
  ok: boolean;
  /** Ids of the steps that are not in place. */
  failed: string[];
}

/**
 * Every step is attempted even after one fails: they are independent, and
 * somebody whose GitHub code expired should not have to repeat the Feature1
 * sign-in they got right.
 */
export async function runSetup(steps: SetupStep[], io: SetupIo): Promise<SetupResult> {
  const failed: string[] = [];
  for (const [index, step] of steps.entries()) {
    io.say(`\n── Step ${index + 1} of ${steps.length}: ${step.title} ──`);
    if (await step.done()) {
      io.say('✓ Already in place');
      continue;
    }
    try {
      await step.perform();
    } catch (error) {
      io.say(`✗ ${(error as Error).message}`);
      failed.push(step.id);
      continue;
    }
    if (await step.done()) {
      io.say('✓ Done, and checked');
    } else {
      io.say('✗ That finished, but the check afterwards says it is still not in place');
      failed.push(step.id);
    }
  }
  io.say(
    failed.length === 0
      ? '\nThis runner is set up. Start it without `setup` and it will begin claiming work.'
      : `\nNot finished: ${failed.join(', ')}. Run setup again; what is done is kept.`
  );
  return { ok: failed.length === 0, failed };
}

/**
 * GitHub, the way the desktop app does it: `gh`'s own browser sign-in.
 *
 * Without `gh auth setup-git`, unlike the desktop. That would make git use
 * gh's login for every command on the machine, the agent's included. The
 * worker instead takes the token from gh at start-up and hands it to its own
 * clone, fetch and push only (credentials.ts).
 */
export function githubStep(commands: SetupCommands): SetupStep {
  return {
    id: 'github',
    title: 'Connect GitHub',
    done: async () => (await commands.probe('gh auth status --hostname github.com')).code === 0,
    perform: async () => {
      const code = await commands.interactive(
        'gh auth login --hostname github.com --git-protocol https --web'
      );
      if (code !== 0) throw new Error('GitHub sign-in did not finish');
    },
  };
}

const AGENT_SIGN_IN: Record<AgentKind, { title: string; probe: string; login: string }> = {
  claude: {
    title: 'Sign in to Claude Code',
    probe: 'claude auth status',
    login: 'claude auth login',
  },
  codex: {
    title: 'Sign in to Codex',
    probe: 'codex login status',
    // Prints a code to enter elsewhere; the default opens a browser here.
    login: 'codex login --device-auth',
  },
};

/** The coding agent this runner uses. A key in the environment already counts. */
export function agentStep(
  agent: AgentKind,
  commands: SetupCommands,
  env: NodeJS.ProcessEnv = process.env
): SetupStep {
  const { title, probe, login } = AGENT_SIGN_IN[agent];
  const keyed =
    agent === 'claude'
      ? Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN)
      : Boolean(env.OPENAI_API_KEY || env.CODEX_API_KEY);
  return {
    id: agent,
    title,
    done: async () => {
      if (keyed) return true;
      const result = await commands.probe(probe);
      if (result.code !== 0) return false;
      // Claude answers in JSON and exits zero either way.
      return agent !== 'claude' || /"loggedIn":\s*true/.test(result.stdout);
    },
    perform: async () => {
      const code = await commands.interactive(login);
      if (code !== 0) throw new Error(`${title} did not finish`);
    },
  };
}

export interface Feature1StepDeps {
  io: SetupIo;
  login: {
    verify(baseUrl: string, token: string): Promise<Feature1Identity>;
    mintRunner(baseUrl: string, token: string, name: string): Promise<MintedRunner>;
  };
  store: { load(): SavedRunner | null; save(saved: SavedRunner): void };
  /** What Feature1 will call this runner. */
  name: string;
  /** Answers supplied ahead of time, so setup can be scripted. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** A credential with less than this left is replaced rather than relied on. */
const RENEW_WITHIN_MS = 60 * 60_000;

/**
 * Feature1: the workspace and a personal token, checked against each other,
 * then exchanged for the runner credential the worker actually runs on.
 */
export function feature1Step(deps: Feature1StepDeps): SetupStep {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  return {
    id: 'feature1',
    title: 'Sign in to Feature1',
    done: async () => {
      const saved = deps.store.load();
      if (!saved || isExpired(saved, now())) return false;
      return Date.parse(saved.expiresAt) - now().getTime() > RENEW_WITHIN_MS;
    },
    perform: async () => {
      const previous = deps.store.load();
      const address =
        (env.MVPFY_FEATURE1_URL ?? '').trim() ||
        (await deps.io.ask(
          previous
            ? `Feature1 workspace address [${previous.feature1BaseUrl}]: `
            : 'Feature1 workspace address (for example https://acme.feature1.ai): '
        )) ||
        previous?.feature1BaseUrl ||
        '';
      if (!address.trim()) throw new Error('A Feature1 workspace address is needed');
      const baseUrl = workspaceBaseUrl(address);

      deps.io.say(
        'Use a personal token from Feature1 → Settings, signed in as an organisation admin.\n' +
          'It is used once, to add this runner, and is not kept.'
      );
      const token =
        (env.MVPFY_FEATURE1_TOKEN ?? '').trim() ||
        (await deps.io.ask('Personal token: ', { secret: true })).trim();
      if (!token) throw new Error('A personal token is needed');

      const identity = await deps.login.verify(baseUrl, token);
      const who = identity.user.email ?? identity.user.id;
      deps.io.say(`Signed in to ${identity.tenant.slug || identity.tenant.id} as ${who}`);

      const minted = await deps.login.mintRunner(baseUrl, token, deps.name);
      const saved: SavedRunner = {
        feature1BaseUrl: baseUrl,
        token: minted.token,
        expiresAt: minted.expiresAt,
        name: deps.name,
      };
      deps.store.save(saved);
      deps.io.say(
        `Runner "${deps.name}" added. Its credential lasts ${timeLeft(saved, now())}; ` +
          'run setup again before then to renew it.'
      );
    },
  };
}
