import { AgentKind } from './agentRun';
import { SavedConnection } from './feature1Connection';
import {
  Feature1Identity,
  Feature1LoginError,
  MintedRunner,
  workspaceBaseUrl,
} from './feature1Login';
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
      ? '\nThis runner is set up.'
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
  /** The sign-in itself, kept so the runner can pull features as the desktop app does. */
  connections: { load(): SavedConnection | null; save(saved: SavedConnection): void };
  /** What Feature1 will call this runner. */
  name: string;
  /**
   * The access the web app left, when the runner was connected there through
   * Feature1's MCP server: then there is no token to ask for.
   */
  mcp?: {
    access: () => { mcpUrl: string; accessToken: string } | null;
    whoami: (
      mcpUrl: string,
      token: string
    ) => Promise<{ tenant: { id: string; slug: string }; user: { id: string; email?: string } }>;
  };
  /** Answers supplied ahead of time, so setup can be scripted. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** A credential with less than this left is replaced rather than relied on. */
const RENEW_WITHIN_MS = 60 * 60_000;

/**
 * Feature1: the workspace and a personal token, checked against each other
 * and kept, as the desktop app keeps them. With that the runner can pull a
 * feature and build it.
 *
 * The same sign-in is then used to ask for a runner credential, which is what
 * lets Feature1 hand this runner work of its own accord. A workspace that does
 * not do that yet, or a person who is not an organisation admin, is told so
 * and is still signed in: pulling needs only the sign-in.
 */
export function feature1Step(deps: Feature1StepDeps): SetupStep {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  return {
    id: 'feature1',
    title: 'Sign in to Feature1',
    done: async () => {
      const saved = deps.connections.load();
      if (!saved) return false;
      // Connected from the web app: the host keeps it alive, not setup.
      if (saved.via === 'mcp') return true;
      // No runner credential is not unfinished: this workspace may not hand
      // out work. One that exists is kept from lapsing.
      const runner = deps.store.load();
      if (!runner) return true;
      return (
        !isExpired(runner, now()) &&
        Date.parse(runner.expiresAt) - now().getTime() > RENEW_WITHIN_MS
      );
    },
    perform: async () => {
      const access = deps.mcp?.access();
      if (access && deps.mcp) {
        const identity = await deps.mcp.whoami(access.mcpUrl, access.accessToken);
        deps.connections.save({
          via: 'mcp',
          feature1BaseUrl: access.mcpUrl,
          token: '',
          tenant: identity.tenant,
          user: identity.user,
        });
        const who = identity.user.email ?? identity.user.id;
        deps.io.say(
          `Connected from the web app, through Feature1's MCP server: ${identity.tenant.slug || identity.tenant.id} as ${who}`
        );
        return;
      }
      const previous = deps.connections.load();
      const scripted = (env.MVPFY_FEATURE1_TOKEN ?? '').trim();
      let identity: Feature1Identity | null = null;
      let baseUrl = '';
      let token = '';

      // Already signed in and only here to renew: use what is kept, and ask
      // only if Feature1 no longer accepts it.
      if (previous && !scripted) {
        try {
          identity = await deps.login.verify(previous.feature1BaseUrl, previous.token);
          baseUrl = previous.feature1BaseUrl;
          token = previous.token;
        } catch {
          deps.io.say('The saved Feature1 sign-in is no longer accepted. Sign in again.');
        }
      }

      if (!identity) {
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
        baseUrl = workspaceBaseUrl(address);

        deps.io.say(
          'Use a personal token from Feature1 → Settings.\n' +
            "It is kept with this runner's other sign-ins, as the desktop app keeps it, so the\n" +
            'runner can read your features. It is never given to the coding agent.'
        );
        token = scripted || (await deps.io.ask('Personal token: ', { secret: true })).trim();
        if (!token) throw new Error('A personal token is needed');
        identity = await deps.login.verify(baseUrl, token);
      }

      deps.connections.save({
        feature1BaseUrl: baseUrl,
        token,
        tenant: identity.tenant,
        user: identity.user,
      });
      const who = identity.user.email ?? identity.user.id;
      deps.io.say(`Signed in to ${identity.tenant.slug || identity.tenant.id} as ${who}`);

      try {
        const minted = await deps.login.mintRunner(baseUrl, token, deps.name);
        const saved: SavedRunner = {
          feature1BaseUrl: baseUrl,
          token: minted.token,
          expiresAt: minted.expiresAt,
          name: deps.name,
        };
        deps.store.save(saved);
        deps.io.say(
          `Runner "${deps.name}" added, so Feature1 can hand it work. That credential lasts ` +
            `${timeLeft(saved, now())}; run setup again before then to renew it.`
        );
      } catch (error) {
        if (!(error instanceof Feature1LoginError)) throw error;
        deps.io.say(
          `Feature1 will not hand this runner work of its own accord: ${error.message}\n` +
            'It can still pull a feature and build it: `implement <feature code>`.'
        );
      }
    },
  };
}
