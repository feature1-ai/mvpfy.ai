import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Finding a repository's checks when nobody named them.
 *
 * It used to be a JavaScript repository's root `package.json` and nothing
 * else: a Python, Go or Java repository had no check to run, and a
 * repository with no check cannot be handed over at all. Nor could a
 * monorepo whose tests live in its packages rather than at its root.
 *
 * So the repository is read the way its own developers would read it: the
 * root first, then the folders a monorepo keeps its parts in, and in each
 * the files every ecosystem announces itself with. What each found part
 * gets is the command its ecosystem runs tests with.
 *
 * Only Node is installed where checks run. Every other ecosystem's checks
 * run in that ecosystem's official image, on the workspace's own Docker
 * engine, with the checkout mounted at the path it has everywhere. Without
 * an engine those checks are reported as unable to run, saying why, rather
 * than skipped in silence.
 */

export interface FoundCheck {
  /** Stable across runs, so a result can be matched to the step that made it. */
  id: string;
  kind: 'test' | 'lint';
  /** What a person reads: the command, and where it ran when not at the root. */
  name: string;
  command: string;
  optional?: boolean;
  /** Needs the workspace's Docker engine to run. */
  needsEngine?: boolean;
}

const read = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Run a command in an image, in this folder, as it is everywhere: same path, same files. */
function inImage(
  image: string,
  folder: string,
  command: string,
  cache: Record<string, string> = {}
): string {
  const caches = Object.entries(cache)
    .map(([inside, name]) => `-v /var/lib/mvpfy/cache/${name}:${inside}`)
    .join(' ');
  return (
    `docker run --rm -v ${quote(folder)}:${quote(folder)} -w ${quote(folder)} ${caches} ` +
    `${image} sh -c ${quote(command)}`
  ).replace(/\s+/g, ' ');
}

/** A version a project pins, when it pins one in the usual place. */
function pinned(folder: string, file: string, pattern: RegExp): string | null {
  const match = read(path.join(folder, file)).match(pattern);
  return match?.[1] ?? null;
}

function packageScripts(folder: string): Record<string, string> | null {
  const text = read(path.join(folder, 'package.json'));
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return null;
  }
}

/** The JavaScript runner for a folder, by its lockfile, the nearest one up to the repository root. */
function jsRunner(folder: string, root: string): 'npm' | 'pnpm' | 'yarn' {
  for (let dir = folder; dir.startsWith(root); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
    if (dir === root) break;
  }
  return 'npm';
}

function hasPythonTests(folder: string): boolean {
  if (
    fs.existsSync(path.join(folder, 'pytest.ini')) ||
    fs.existsSync(path.join(folder, 'conftest.py'))
  )
    return true;
  if (/\[tool\.pytest/.test(read(path.join(folder, 'pyproject.toml')))) return true;
  if (/\[tool:pytest\]/.test(read(path.join(folder, 'setup.cfg')))) return true;
  for (const dir of ['tests', 'test']) {
    try {
      if (fs.readdirSync(path.join(folder, dir)).some((f) => /^test_.*\.py$|_test\.py$/.test(f)))
        return true;
    } catch {
      // No such folder.
    }
  }
  return false;
}

/** The checks for one part of the repository, found by what is in its folder. */
function checksIn(
  folder: string,
  root: string,
  label: string,
  monorepoRoot: boolean
): FoundCheck[] {
  const at = (file: string) => fs.existsSync(path.join(folder, file));
  const where = label ? ` in ${label}` : '';
  const id = (kind: string) =>
    `discovered-${kind}${label ? `-${label.replace(/[^a-z0-9]+/gi, '-')}` : ''}`;
  const cd = label ? `cd ${quote(label)} && ` : '';
  const found: FoundCheck[] = [];

  const scripts = packageScripts(folder);
  if (scripts) {
    const runner = jsRunner(folder, root);
    const run = (script: string) =>
      runner === 'npm'
        ? script === 'test'
          ? 'npm test --silent'
          : `npm run ${script} --silent`
        : `corepack ${runner} run ${script}`;
    // A package's own dependencies, when it keeps them apart from the root's.
    const install = label
      ? `([ -d node_modules ] || [ -d ../node_modules ] || [ -d ../../node_modules ] || ${
          runner === 'npm' ? 'npm install --no-audit --no-fund' : `corepack ${runner} install`
        }) && `
      : '';
    if (scripts.test && !/no test specified/.test(scripts.test)) {
      found.push({
        id: id('test'),
        kind: 'test',
        name: `${runner} test${where}`,
        command: `${cd}${install}${run('test')}`,
      });
    } else if (monorepoRoot) {
      // A root that only fans out: run every package's tests through its tool.
      const fanOut = at('turbo.json')
        ? 'npx --no-install turbo run test'
        : runner === 'pnpm'
          ? 'corepack pnpm -r --if-present run test'
          : runner === 'yarn'
            ? 'corepack yarn workspaces foreach -A run test'
            : 'npm test --workspaces --if-present --silent';
      found.push({
        id: id('test'),
        kind: 'test',
        name: `every package's tests${where}`,
        command: `${cd}${fanOut}`,
      });
    }
    if (scripts.lint) {
      found.push({
        id: id('lint'),
        kind: 'lint',
        name: `${runner} run lint${where}`,
        command: `${cd}${install}${run('lint')}`,
        optional: true,
      });
    }
    return found;
  }

  if (at('go.mod')) {
    const version = pinned(folder, 'go.mod', /^go (\d+\.\d+)/m) ?? '1';
    const image = `golang:${version}`;
    found.push({
      id: id('test'),
      kind: 'test',
      name: `go test${where}`,
      command: inImage(image, folder, 'go test ./...', { '/go/pkg/mod': 'go' }),
      needsEngine: true,
    });
    found.push({
      id: id('lint'),
      kind: 'lint',
      name: `go vet${where}`,
      command: inImage(image, folder, 'go vet ./...', { '/go/pkg/mod': 'go' }),
      optional: true,
      needsEngine: true,
    });
    return found;
  }
  if (at('Cargo.toml')) {
    const version =
      pinned(folder, 'rust-toolchain.toml', /channel\s*=\s*"(\d+\.\d+(?:\.\d+)?)"/) ?? '1';
    found.push({
      id: id('test'),
      kind: 'test',
      name: `cargo test${where}`,
      command: inImage(`rust:${version}`, folder, 'cargo test --quiet', {
        '/usr/local/cargo/registry': 'cargo',
      }),
      needsEngine: true,
    });
    return found;
  }
  if (at('pyproject.toml') || at('setup.py') || at('requirements.txt') || at('setup.cfg')) {
    if (!hasPythonTests(folder)) return found;
    const version =
      pinned(folder, '.python-version', /^(\d+\.\d+)/m) ??
      pinned(folder, 'pyproject.toml', /requires-python\s*=\s*"[^"\d]*(\d+\.\d+)/) ??
      '3.12';
    const install = [
      ...[
        'requirements.txt',
        'requirements-dev.txt',
        'requirements-test.txt',
        'dev-requirements.txt',
      ]
        .filter((f) => at(f))
        .map((f) => `pip install -q -r ${f}`),
      ...(at('pyproject.toml') || at('setup.py')
        ? ["(pip install -q -e '.[test]' || pip install -q -e '.[dev]' || pip install -q -e .)"]
        : []),
      'pip install -q pytest',
    ].join(' && ');
    found.push({
      id: id('test'),
      kind: 'test',
      name: `pytest${where}`,
      command: inImage(`python:${version}-slim`, folder, `${install} && python -m pytest -q`, {
        '/root/.cache/pip': 'pip',
      }),
      needsEngine: true,
    });
    return found;
  }
  if (at('pom.xml')) {
    found.push({
      id: id('test'),
      kind: 'test',
      name: `mvn test${where}`,
      command: inImage('maven:3-eclipse-temurin-21', folder, 'mvn -q -B test', {
        '/root/.m2': 'maven',
      }),
      needsEngine: true,
    });
    return found;
  }
  if (at('build.gradle') || at('build.gradle.kts')) {
    const gradle = at('gradlew') ? './gradlew' : 'gradle';
    found.push({
      id: id('test'),
      kind: 'test',
      name: `gradle test${where}`,
      command: inImage('gradle:8-jdk21', folder, `${gradle} test --no-daemon -q`, {
        '/home/gradle/.gradle': 'gradle',
      }),
      needsEngine: true,
    });
    return found;
  }
  if (at('Gemfile')) {
    const version = pinned(folder, '.ruby-version', /^(\d+\.\d+)/m) ?? '3.3';
    const tests = at('spec') ? 'bundle exec rspec' : 'bundle exec rake test';
    found.push({
      id: id('test'),
      kind: 'test',
      name: `${tests.replace('bundle exec ', '')}${where}`,
      command: inImage(`ruby:${version}`, folder, `bundle install --quiet && ${tests}`, {
        '/usr/local/bundle': 'bundle',
      }),
      needsEngine: true,
    });
    return found;
  }
  return found;
}

/** Where a monorepo keeps its parts, and the usual names of a part kept at the top. */
const PART_PARENTS = ['apps', 'packages', 'services', 'libs'];
const PART_NAMES = [
  'backend',
  'frontend',
  'api',
  'server',
  'web',
  'client',
  'app',
  'mobile',
  'worker',
];
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'vendor',
  '.venv',
  'venv',
  'target',
]);

function partsOf(root: string): string[] {
  const parts: string[] = [];
  const dirs = (dir: string) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !SKIP.has(d.name) && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch {
      return [];
    }
  };
  for (const parent of PART_PARENTS) {
    for (const name of dirs(path.join(root, parent))) parts.push(`${parent}/${name}`);
  }
  for (const name of dirs(root)) if (PART_NAMES.includes(name)) parts.push(name);
  return parts.sort();
}

function isMonorepoRoot(root: string): boolean {
  const pkg = read(path.join(root, 'package.json'));
  return (
    /"workspaces"\s*:/.test(pkg) ||
    ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json'].some((f) =>
      fs.existsSync(path.join(root, f))
    )
  );
}

/**
 * Every check this repository has, at its root and in its parts.
 *
 * A JavaScript monorepo with a root test script is run from the root alone,
 * as its developers run it; one without is run through its workspace tool.
 * Parts in another ecosystem — a Python API beside a web app — are found as
 * well, whatever the root is.
 */
export function discoverChecks(root: string): FoundCheck[] {
  const monorepo = isMonorepoRoot(root);
  const atRoot = checksIn(root, root, '', monorepo);
  const rootCoversJs = monorepo && atRoot.some((c) => c.kind === 'test');
  const parts = partsOf(root).flatMap((part) => {
    const folder = path.join(root, part);
    const found = checksIn(folder, root, part, false);
    // The root already runs every JavaScript package; do not run them twice.
    return rootCoversJs && fs.existsSync(path.join(folder, 'package.json')) ? [] : found;
  });
  return [...atRoot, ...parts];
}
