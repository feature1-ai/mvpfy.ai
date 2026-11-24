import { UnitCheckSpec } from '../../shared/agentUnits';
import { manifestPorts } from '../../shared/manifest';
import { composeBase, spawnEnv } from './docker';
import { readRepoFiles } from './repoFiles';
import { ShellResult, spawnShellAsync } from './shell';

/**
 * Looking at what an agent left behind, instead of asking it.
 *
 * Each kind of evidence is one small function that says nothing when the
 * evidence is there and a sentence when it is not. The sentence is written
 * for whoever has to put it right, because it becomes the next attempt's
 * brief word for word.
 *
 * A check that cannot be made is not a check that failed. Docker missing
 * from this machine says nothing about whether the compose file is right, so
 * it passes with nothing said: failing a step for something the step could
 * not have changed would send an agent to fix a file that is fine.
 *
 * A new kind of evidence is a new entry in EVALUATORS and a new member of
 * UnitCheckSpec. Nothing that runs the checks changes.
 */

/** What a check may touch. Injected, so the tests need no disk and no Docker. */
export interface CheckAccess {
  /** A workspace file's text, or null when it is not there. */
  read(relativePath: string): string | null;
  /** Run a command from the workspace root. */
  run(command: string): Promise<ShellResult>;
}

/** The real thing: the workspace on disk, held to the same guard as every other read. */
export function workspaceAccess(repoPath: string): CheckAccess {
  return {
    read: (relativePath) => {
      const [file] = readRepoFiles(repoPath, [relativePath]);
      return file?.exists ? (file.content ?? '') : null;
    },
    run: (command) => spawnShellAsync(command, { cwd: repoPath, env: spawnEnv(), timeout: 60_000 }),
  };
}

type SpecOf<K extends UnitCheckSpec['kind']> = Extract<UnitCheckSpec, { kind: K }>;
type Evaluator<K extends UnitCheckSpec['kind']> = (
  spec: SpecOf<K>,
  access: CheckAccess
) => Promise<string | null> | string | null;

/** The end of what a command printed, which is where it says what was wrong. */
function tail(text: string, max = 1500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** The command could not be run at all, as opposed to running and saying no. */
function couldNotRun(result: ShellResult): boolean {
  if (result.status === null || result.status === 127) return true;
  return /command not found|is not recognized as|is not a docker command/i.test(result.stderr);
}

const EVALUATORS: { [K in UnitCheckSpec['kind']]: Evaluator<K> } = {
  files: (spec, access) => {
    const missing = spec.paths.filter((p) => !(access.read(p) ?? '').trim());
    if (missing.length === 0) return null;
    return `${missing.length === 1 ? 'This file is' : 'These files are'} missing or empty: ${missing.join(', ')}.`;
  },

  contains: (spec, access) => {
    const text = access.read(spec.path);
    if (text === null) return `${spec.path} does not exist.`;
    const absent = spec.needles.filter((needle) => !text.includes(needle));
    if (absent.length === 0) return null;
    return `${spec.path} does not contain ${absent.map((n) => `"${n}"`).join(' or ')}.`;
  },

  imports: (spec, access) => {
    const text = access.read(spec.path);
    if (text === null) return `${spec.path} does not exist.`;
    // Each @reference on its own terms rather than a substring of the file:
    // a line that merely mentions the name in prose is not an import, and
    // `./AGENTS.md` is the same import as `AGENTS.md`.
    const imported = text.split('\n').some((line) => {
      const at = line.indexOf('@');
      if (at === -1) return false;
      const reference =
        line
          .slice(at + 1)
          .trim()
          .split(/\s/)[0] ?? '';
      return reference.replace(/^\.?\//, '') === spec.target;
    });
    if (imported) return null;
    return `${spec.path} does not import ${spec.target} (expected a line with @${spec.target}).`;
  },

  'compose-config': async (spec, access) => {
    const command = `${composeBase(spec.linked)} config -q`;
    const result = await access.run(command);
    if (result.status === 0 || couldNotRun(result)) return null;
    return (
      `Docker does not accept the generated stack. \`${command}\` exited with code ` +
      `${result.status}:\n${tail(result.stderr || result.stdout) || '(it printed nothing)'}`
    );
  },

  'manifest-ports': (spec, access) => {
    const text = access.read(spec.path);
    if (text === null) return `${spec.path} does not exist.`;
    const { hostPort, urlPort } = manifestPorts(text);
    if (hostPort === null && urlPort === null) {
      return (
        `${spec.path} does not say which port the app is on. It needs the main app's ` +
        '`host_port:` and a `url:` of the form http://localhost:<port>.'
      );
    }
    if (hostPort !== null && urlPort !== null && hostPort !== urlPort) {
      return (
        `${spec.path} names two different ports for the app: host_port is ${hostPort} but the ` +
        `url points at ${urlPort}. They must be the same port the compose file publishes.`
      );
    }
    return null;
  },

  'demo-login': (spec, access) => {
    // One direction only. An env file that defines the demo account is a
    // promise that the seed uses it, and mvpfy.yml is what the product
    // manager is shown — so those values have to be in it. The reverse is not
    // asserted: the account may be defined in a component's own env file,
    // which is where the instructions say a variable belongs.
    const env = access.read(spec.env);
    if (env === null) return null;
    const email = envValue(env, 'MVPFY_DEMO_EMAIL');
    const password = envValue(env, 'MVPFY_DEMO_PASSWORD');
    if (!email && !password) return null;
    const manifest = access.read(spec.manifest);
    if (manifest === null) return `${spec.manifest} does not exist.`;
    const absent = [
      ...(email && !manifest.includes(email) ? ['MVPFY_DEMO_EMAIL'] : []),
      ...(password && !manifest.includes(password) ? ['MVPFY_DEMO_PASSWORD'] : []),
    ];
    if (absent.length === 0) return null;
    return (
      `${spec.env} defines a demo account, but ${spec.manifest} does not show the same ` +
      `${absent.join(' and ')}. The product manager is shown the login in ${spec.manifest}; ` +
      'its `demo_login:` block must carry exactly the values the seed uses.'
    );
  },
};

/** `KEY=value` out of an env file, unquoted. Undefined when the key is not set. */
function envValue(text: string, key: string): string | undefined {
  const line = text.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm'));
  if (!line) return undefined;
  const value = line[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  return value || undefined;
}

/** Every piece of evidence that is not there, as sentences. Empty means it all holds. */
export async function failedChecks(specs: UnitCheckSpec[], access: CheckAccess): Promise<string[]> {
  const failures: string[] = [];
  for (const spec of specs) {
    const evaluate = EVALUATORS[spec.kind] as Evaluator<typeof spec.kind>;
    try {
      const failure = await evaluate(spec, access);
      if (failure) failures.push(failure);
    } catch {
      // A check that threw could not be made; see the note at the top.
    }
  }
  return failures;
}
