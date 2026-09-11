import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CreateProjectResult, RepoCloneOutcome, RepoFile } from '../../shared/types';
import { slugFromRepoUrl } from '../../shared/slug';
import {
  ensureDirs,
  isAllowedWorkspace,
  isLinkedPath,
  isManagedPath,
  isWorktreePath,
  PROJECTS_DIR,
  WORKTREES_DIR,
} from '../paths';
import { ideContainerName, spawnEnv } from './docker';
import { cdTo, shellQuote, spawnShell, spawnShellSync } from './shell';

/** Project workspace lifecycle: create (clone), read/write files, delete. */

function gitClone(repoUrl: string, dest: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawnShell(`git clone ${shellQuote(repoUrl)} ${shellQuote(dest)}`, {
      cwd: PROJECTS_DIR,
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `git clone exited with code ${code}` });
    });
  });
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Local filesystem path (absolute, ~, relative, or Windows drive letter). */
function isLocalSource(entry: string): boolean {
  return /^([~/.]|[A-Za-z]:[\\/])/.test(entry);
}

/**
 * Clone a source into the workspace. Remote URLs clone as-is; local repos are
 * cloned from disk (fast, hardlinked objects) and keep their original origin
 * remote so push/PR flows still target the real remote.
 */
async function cloneSource(source: string, dest: string): Promise<{ ok: boolean; error?: string }> {
  if (!isLocalSource(source)) return gitClone(source, dest);
  const src = path.resolve(expandHome(source));
  if (!fs.existsSync(src)) {
    return { ok: false, error: `Local path does not exist: ${src}` };
  }
  if (!fs.existsSync(path.join(src, '.git'))) {
    return { ok: false, error: `Not a git repository: ${src}` };
  }
  const res = await gitClone(src, dest);
  if (!res.ok) return res;
  const origin = spawnShellSync(`git -C ${shellQuote(src)} remote get-url origin`, {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const originUrl = origin.status === 0 ? origin.stdout.trim() : '';
  if (originUrl) {
    spawnShellSync(`git -C ${shellQuote(dest)} remote set-url origin ${shellQuote(originUrl)}`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
  }
  return res;
}

/**
 * Create a project workspace. A single URL is cloned directly as the workspace
 * root; multiple URLs get a shared workspace folder with one subdirectory per
 * repo, so one compose file at the root can run the whole stack.
 */
export async function createProject(repoUrls: string[]): Promise<CreateProjectResult> {
  ensureDirs();
  const urls = repoUrls.map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    return { ok: false, slug: '', workspacePath: '', repos: [], error: 'No repo URLs given' };
  }
  const baseSlug =
    urls.length === 1 ? slugFromRepoUrl(urls[0]) : `${slugFromRepoUrl(urls[0])}-stack`;
  let slug = baseSlug;
  let n = 2;
  while (fs.existsSync(path.join(PROJECTS_DIR, slug))) {
    slug = `${baseSlug}-${n++}`;
  }
  const workspacePath = path.join(PROJECTS_DIR, slug);
  const repos: RepoCloneOutcome[] = [];

  if (urls.length === 1) {
    const res = await cloneSource(urls[0], workspacePath);
    repos.push({ url: urls[0], dir: workspacePath, ...res });
  } else {
    fs.mkdirSync(workspacePath, { recursive: true });
    const used = new Set<string>();
    for (const url of urls) {
      const repoSlugBase = slugFromRepoUrl(url);
      let repoSlug = repoSlugBase;
      let m = 2;
      while (used.has(repoSlug)) repoSlug = `${repoSlugBase}-${m++}`;
      used.add(repoSlug);
      const dir = path.join(workspacePath, repoSlug);
      const res = await cloneSource(url, dir);
      repos.push({ url, dir, ...res });
    }
  }

  const failed = repos.filter((r) => !r.ok);
  if (failed.length > 0) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    return {
      ok: false,
      slug,
      workspacePath,
      repos,
      error: failed.map((r) => `${r.url}: ${r.error}`).join('\n'),
    };
  }
  return { ok: true, slug, workspacePath, repos };
}

/**
 * Use a local folder in place — no clone, mvpfy works directly in it. The
 * folder must be a git repository, or a folder whose immediate subdirectories
 * contain git repositories (a hand-made multi-repo workspace).
 */
export function linkProject(sourcePath: string): CreateProjectResult {
  const src = path.resolve(expandHome(sourcePath.trim()));
  const fail = (error: string): CreateProjectResult => ({
    ok: false,
    slug: '',
    workspacePath: src,
    repos: [],
    error,
  });
  if (!fs.existsSync(src)) return fail(`Local path does not exist: ${src}`);
  if (isManagedPath(src)) return fail('That folder is already a managed mvpfy workspace');

  const originOf = (dir: string): string => {
    const res = spawnShellSync(`git -C ${shellQuote(dir)} remote get-url origin`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return res.status === 0 ? res.stdout.trim() : '';
  };

  const repos: RepoCloneOutcome[] = [];
  if (fs.existsSync(path.join(src, '.git'))) {
    repos.push({ url: originOf(src) || src, dir: src, ok: true });
  } else {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(src, entry.name);
      if (fs.existsSync(path.join(dir, '.git'))) {
        repos.push({ url: originOf(dir) || dir, dir, ok: true });
      }
    }
    if (repos.length === 0) {
      return fail(`Not a git repository (and no git repositories inside): ${src}`);
    }
  }
  return { ok: true, slug: path.basename(src), workspacePath: src, repos };
}

/**
 * Shell command that pulls the latest changes into each repo directory, with
 * a heading per repo so the streamed log stays readable. Every directory must
 * be a managed or linked workspace path; anything else is rejected.
 */
export function repoSyncCommand(dirs: string[]): string {
  return dirs
    .map((d) => {
      const dir = path.resolve(d);
      if (!isAllowedWorkspace(dir)) {
        throw new Error('Sync is restricted to managed and linked project directories');
      }
      const heading = shellQuote(`── ${path.basename(dir)}`);
      return `echo ${heading} && git -C ${shellQuote(dir)} pull --ff-only`;
    })
    .join(' && ');
}

/**
 * Where a feature's checkout of one repository lives. Keyed by project as well
 * as feature, because two projects may hold repositories of the same name.
 */
export function worktreePathFor(projectKey: string, featureSlug: string, repoDir: string): string {
  const safe = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x';
  return path.join(
    WORKTREES_DIR,
    safe(projectKey),
    safe(featureSlug || 'feature'),
    safe(path.basename(repoDir))
  );
}

/**
 * Add a checkout of the feature branch for every repository, so implementing a
 * story never touches the working copy the builder tests from.
 *
 * Worktrees share the repository's object store, so a commit made in one is
 * immediately visible to the original — which is why raising the pull request
 * still works from the workspace and needs to know nothing about any of this.
 */
export function worktreeAddCommand(
  projectKey: string,
  featureSlug: string,
  dirs: string[],
  branch: string
): string {
  const parts: string[] = [];
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) {
      throw new Error('Worktrees are restricted to managed and linked project directories');
    }
    const target = worktreePathFor(projectKey, featureSlug, dir);
    // Guaranteed by construction; asserted because this path is handed to rm.
    if (!isWorktreePath(target)) throw new Error('Refusing to place a worktree outside ~/.mvpfy');
    if (fs.existsSync(target)) continue;
    const base = defaultBranchOf(dir);
    const exists =
      spawnShellSync(`git -C ${shellQuote(dir)} rev-parse --verify ${shellQuote(branch)}`, {
        encoding: 'utf8',
        timeout: 10_000,
      }).status === 0;
    // An existing branch is checked out as it stands; a new one starts from the
    // trunk, never from whatever the workspace happens to have checked out.
    const add = exists
      ? `git -C ${shellQuote(dir)} worktree add ${shellQuote(target)} ${shellQuote(branch)}`
      : `git -C ${shellQuote(dir)} worktree add -b ${shellQuote(branch)} ${shellQuote(target)} ` +
        `${shellQuote(`origin/${base}`)}`;
    parts.push(`echo ${shellQuote(`── ${path.basename(dir)}`)} && ${add}`);
  }
  if (parts.length === 0) return 'echo "Every worktree for this feature already exists"';
  return parts.join(' && ');
}

/**
 * Create the feature's checkouts and report where they are.
 *
 * Runs to completion rather than streaming: it is quick — a worktree shares
 * the repository's object store — and the caller needs the paths before it can
 * tell an agent where to work.
 */
export async function addWorktrees(
  projectKey: string,
  featureSlug: string,
  dirs: string[],
  branch: string
): Promise<{ ok: boolean; paths: Record<string, string>; error?: string }> {
  ensureDirs();
  const paths: Record<string, string> = {};
  for (const d of dirs) paths[path.resolve(d)] = worktreePathFor(projectKey, featureSlug, d);
  try {
    const command = worktreeAddCommand(projectKey, featureSlug, dirs, branch);
    const result = await runCapturing(command);
    return result.ok ? { ok: true, paths } : { ok: false, paths, error: result.output };
  } catch (err) {
    return { ok: false, paths, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove a feature's checkouts, once its work is safely on the remote. */
export async function removeWorktrees(
  projectKey: string,
  featureSlug: string,
  dirs: string[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await runCapturing(worktreeRemoveCommand(projectKey, featureSlug, dirs));
    return result.ok ? { ok: true } : { ok: false, error: result.output };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function runCapturing(command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawnShell(command, { cwd: PROJECTS_DIR, env: spawnEnv() });
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.on('error', (err) => resolve({ ok: false, output: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

/** Remove a feature's checkouts once its work is pushed. */
export function worktreeRemoveCommand(
  projectKey: string,
  featureSlug: string,
  dirs: string[]
): string {
  const parts: string[] = [];
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) {
      throw new Error('Worktrees are restricted to managed and linked project directories');
    }
    const target = worktreePathFor(projectKey, featureSlug, dir);
    if (!isWorktreePath(target)) throw new Error('Refusing to remove a path outside ~/.mvpfy');
    if (!fs.existsSync(target)) continue;
    // --force because the checkout may hold build output; the branch and its
    // commits live in the repository and are untouched by this.
    parts.push(
      `git -C ${shellQuote(dir)} worktree remove --force ${shellQuote(target)} && ` +
        `git -C ${shellQuote(dir)} worktree prune`
    );
  }
  if (parts.length === 0) return 'echo "Nothing to remove"';
  return parts.join(' && ');
}

/**
 * The branch a repository treats as its trunk. Read from origin/HEAD, which is
 * what the remote itself says; `main` only as a last resort.
 */
function defaultBranchOf(dir: string): string {
  const res = spawnShellSync(`git -C ${shellQuote(dir)} rev-parse --abbrev-ref origin/HEAD`, {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const name = res.status === 0 ? res.stdout.trim().replace(/^origin\//, '') : '';
  return name || 'main';
}

/** True when this repository has the branch at all. */
function hasBranch(dir: string, branch: string): boolean {
  return (
    spawnShellSync(`git -C ${shellQuote(dir)} rev-parse --verify ${shellQuote(branch)}`, {
      encoding: 'utf8',
      timeout: 10_000,
    }).status === 0
  );
}

/** Commits `branch` has that `base` does not, or -1 when the range is unknown. */
function commitsAhead(dir: string, base: string, branch: string): number {
  const count = (range: string) =>
    spawnShellSync(`git -C ${shellQuote(dir)} rev-list --count ${shellQuote(range)}`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
  // Prefer the remote's copy of the trunk; fall back to the local one, which is
  // all there is on a repository that has never been pushed.
  for (const range of [`origin/${base}..${branch}`, `${base}..${branch}`]) {
    const res = count(range);
    if (res.status === 0) return Number(res.stdout.trim()) || 0;
  }
  // Neither range resolved, so the question is unanswered rather than answered
  // no. Say "unknown" and let the caller try anyway: excluding a repository on
  // a failed git command is how a pull request silently never gets raised, and
  // GitHub refusing it says far more than mvpfy quietly deciding not to ask.
  return -1;
}

/**
 * Put the workspace on a feature's code so the running app is that feature.
 *
 * Detached on purpose, and not merely to be careful: git refuses to check a
 * branch out when a worktree already has it, which is always the case for a
 * feature being worked on. Detaching is allowed alongside a worktree, and the
 * semantics are the ones wanted here anyway — the workspace is for running the
 * product, not for committing to it.
 */
export function checkoutFeatureCommand(dirs: string[], branch: string): string {
  const parts: string[] = [];
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) {
      throw new Error('Checkout is restricted to managed and linked project directories');
    }
    const known =
      spawnShellSync(`git -C ${shellQuote(dir)} rev-parse --verify ${shellQuote(branch)}`, {
        encoding: 'utf8',
        timeout: 10_000,
      }).status === 0;
    // A repository the feature never reached has no such branch; leaving it on
    // its trunk is correct, not an error.
    if (!known) continue;
    parts.push(
      `echo ${shellQuote(`── ${path.basename(dir)}`)} && ` +
        `git -C ${shellQuote(dir)} checkout --detach ${shellQuote(branch)}`
    );
  }
  if (parts.length === 0) {
    throw new Error(`No repository has a ${branch} branch yet — implement a story first.`);
  }
  return parts.join(' && ');
}

/**
 * Is the workspace actually showing this feature's latest work?
 *
 * Checking a feature out detaches HEAD at the branch tip as it stands, so a
 * story implemented afterwards adds a commit the workspace never sees — the
 * app would keep running pre-story code while claiming to be that feature.
 * Stored state cannot know this; only the repository can be asked.
 */
export function featureCheckedOut(dirs: string[], branch: string): boolean {
  const sha = (dir: string, ref: string) => {
    const res = spawnShellSync(`git -C ${shellQuote(dir)} rev-parse ${shellQuote(ref)}`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return res.status === 0 ? res.stdout.trim() : '';
  };
  let sawBranch = false;
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) return false;
    const tip = sha(dir, branch);
    // A repository the feature never reached has no branch, and correctly
    // stays on its trunk; it says nothing either way.
    if (!tip) continue;
    sawBranch = true;
    if (sha(dir, 'HEAD') !== tip) return false;
  }
  return sawBranch;
}

/** Put every repository back on its own trunk. */
export function checkoutDefaultCommand(dirs: string[]): string {
  return dirs
    .map((d) => {
      const dir = path.resolve(d);
      if (!isAllowedWorkspace(dir)) {
        throw new Error('Checkout is restricted to managed and linked project directories');
      }
      return `git -C ${shellQuote(dir)} checkout ${shellQuote(defaultBranchOf(dir))}`;
    })
    .join(' && ');
}

/** Check a feature's code out for testing, or go back to the trunk. */
export async function checkoutFeature(
  dirs: string[],
  branch: string | null
): Promise<{ ok: boolean; error?: string }> {
  try {
    const command = branch ? checkoutFeatureCommand(dirs, branch) : checkoutDefaultCommand(dirs);
    const result = await runCapturing(command);
    return result.ok ? { ok: true } : { ok: false, error: result.output };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Push a feature branch and open its pull requests.
 *
 * A pull request with no commits cannot exist — GitHub rejects it outright — so
 * the branch is uniform across every repository but the pull requests are not.
 * Which repositories changed is decided here by counting commits, never by
 * asking the agent what it thinks it touched.
 */
export function raisePrCommand(
  dirs: string[],
  branch: string,
  title: string,
  body: string
): string {
  const targets: Array<{ dir: string; base: string }> = [];
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) {
      throw new Error('Pull requests are restricted to managed and linked project directories');
    }
    // No such branch here is a real no — the feature never reached this
    // repository, and it correctly stays on its trunk.
    if (!hasBranch(dir, branch)) continue;
    const base = defaultBranchOf(dir);
    // But -1 is "could not tell", not "nothing there". Attempting and having
    // GitHub refuse says far more than mvpfy quietly deciding not to ask, which
    // is how a pull request silently never gets raised at all.
    if (commitsAhead(dir, base, branch) !== 0) targets.push({ dir, base });
  }
  if (targets.length === 0) {
    // Say what was looked at, not just that nothing was found: the usual
    // causes are a branch that was never created, stories moved to Done by
    // hand without being implemented, and commits that never reached the
    // branch — and those are told apart by naming the branch and the repos.
    const looked = dirs.map((d) => path.basename(path.resolve(d))).join(', ');
    throw new Error(
      `Nothing to raise: ${branch} has no commits in ${looked}. ` +
        `Implement a story first — moving one to Done by hand does not write any code.`
    );
  }
  return targets
    .map(({ dir, base }) => {
      const heading = shellQuote(`── ${path.basename(dir)}`);
      // An existing pull request is success, not failure: print its URL rather
      // than failing the run because the branch was raised once already.
      return (
        `echo ${heading} && ${cdTo(dir)} && git push -u origin ${shellQuote(branch)} && ` +
        `(gh pr create --base ${shellQuote(base)} --head ${shellQuote(branch)} ` +
        `--title ${shellQuote(title)} --body ${shellQuote(body)} || ` +
        `gh pr view ${shellQuote(branch)} --json url -q .url)`
      );
    })
    .join(' && ');
}

/** Current branch per repo dir (empty string when not resolvable). */
export function readRepoBranches(dirs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    if (!isAllowedWorkspace(resolved)) {
      out[dir] = '';
      continue;
    }
    const res = spawnShellSync(`git -C ${shellQuote(resolved)} branch --show-current`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
    out[dir] = res.status === 0 ? res.stdout.trim() : '';
  }
  return out;
}

export function readRepoFiles(repoPath: string, relativePaths: string[]): RepoFile[] {
  const root = path.resolve(repoPath);
  return relativePaths.map((rel) => {
    const abs = path.resolve(root, rel);
    // Prevent path traversal outside the repo.
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { relativePath: rel, exists: false, content: null };
    }
    try {
      const content = fs.readFileSync(abs, 'utf8');
      return { relativePath: rel, exists: true, content };
    } catch {
      return { relativePath: rel, exists: false, content: null };
    }
  });
}

export function writeRepoFile(repoPath: string, relativePath: string, content: string): void {
  const root = path.resolve(repoPath);
  const abs = path.resolve(root, relativePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Refusing to write outside the repo');
  }
  fs.writeFileSync(abs, content, 'utf8');
}

/**
 * Delete a project. Managed workspaces (clones under ~/.mvpfy/projects) are
 * torn down completely — Docker stack, volumes, and the directory. Linked
 * (in-place) folders are the user's real code: only mvpfy's containers and
 * generated files are removed, NEVER the folder or anything else in it.
 */
export async function deleteProject(
  workspacePath: string
): Promise<{ ok: boolean; error?: string }> {
  const resolved = path.resolve(workspacePath);
  const linked = isLinkedPath(resolved) && !isManagedPath(resolved);
  if (!linked && !isManagedPath(resolved)) {
    return { ok: false, error: 'Refusing to delete outside ~/.mvpfy/projects' };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: true };
  }
  try {
    // Remove the project's IDE container if one was launched.
    await runToCompletion(`docker rm -f ${ideContainerName(resolved)}`, undefined);
    for (const composeFile of ['docker-compose.mvpfy.yml', '.mvpfy/docker-compose.mvpfy.yml']) {
      if (fs.existsSync(path.join(resolved, composeFile))) {
        await runToCompletion(
          `docker compose -f ${composeFile} --project-directory . down --volumes --remove-orphans`,
          resolved
        );
      }
    }
    if (linked) {
      // Linked mode keeps everything mvpfy wrote inside .mvpfy/; the sweep of
      // root-level names is insurance in case an agent ignored that rule.
      fs.rmSync(path.join(resolved, '.mvpfy'), { recursive: true, force: true });
      removeGeneratedFiles(resolved);
    } else {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Remove only what mvpfy itself wrote into a linked folder. Deliberately
 * conservative: a Dockerfile is left alone (it may predate mvpfy or be
 * committed by now), as is anything not on this explicit list.
 */
function removeGeneratedFiles(root: string): void {
  const exact = [
    'mvpfy.yml',
    'docker-compose.mvpfy.yml',
    '.env.mvpfy.example',
    'mvpfy-run.md',
    'mvpfy-summary.md',
    'mvpfy-questions.md',
    'mvpfy-answers.md',
    'mvpfy-triage.md',
    'mvpfy-change.md',
  ];
  for (const entry of fs.readdirSync(root)) {
    const isPlanFile = /^mvpfy-(plan|spec)($|\.)/.test(entry);
    if (!exact.includes(entry) && !isPlanFile && entry !== 'mvpfy') continue;
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

function runToCompletion(command: string, cwd: string | undefined): Promise<void> {
  return new Promise((resolve) => {
    const child = spawnShell(command, { cwd, env: spawnEnv() });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}
