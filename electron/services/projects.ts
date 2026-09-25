import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CreateProjectResult,
  MergeConflicts,
  RepoCloneOutcome,
  RepoFile,
} from '../../shared/types';
import {
  BlankProjectRemote,
  designDirFor,
  FeatureRepoGit,
  planFileFor,
  specFileFor,
} from '../../shared/types';
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
import { cdTo, IS_WIN, shellQuote, spawnShell, spawnShellSync } from './shell';

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
 * Give a repository with no commits one, so the rest of mvpfy works on it.
 *
 * A brand-new repository — the empty one someone just made on GitHub — has an
 * unborn HEAD, and `git worktree add -b` refuses it outright: "fatal: not a
 * valid object name: 'HEAD'". Every feature starts by making a worktree, so
 * nothing at all could be built in a fresh repository, and the failure landed
 * mid-run with git's words rather than at the point of setting the project up.
 * One empty commit removes the whole class of problem.
 *
 * Untouched when HEAD already resolves, so an existing product never gets an
 * extra commit on top of its history.
 */
export function ensureInitialCommit(dir: string): void {
  const q = shellQuote(path.resolve(dir));
  const head = spawnShellSync(`git -C ${q} rev-parse --verify HEAD`, {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (head.status === 0) return;
  // git refuses to commit without an identity, and a machine that has never
  // configured one is exactly the machine someone is setting mvpfy up on. Only
  // used when the user has not set their own — never overriding it.
  const email = spawnShellSync(`git -C ${q} config user.email`, {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const identity =
    email.status === 0 && email.stdout.trim()
      ? ''
      : `-c ${shellQuote('user.name=mvpfy')} -c ${shellQuote('user.email=noreply@feature1.ai')} `;
  spawnShellSync(`git -C ${q} ${identity}commit --allow-empty -m ${shellQuote('Initial commit')}`, {
    encoding: 'utf8',
    timeout: 20_000,
  });
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

  // A repository that arrived empty cannot hold a worktree, and every feature
  // begins with one. Done here so the project is usable the moment it exists.
  for (const r of repos) {
    if (r.ok) ensureInitialCommit(r.dir);
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
 * True when there is no product here yet — every repository in the workspace
 * tracks nothing but mvpfy's own files.
 *
 * The prompts have always told the agent to read the existing product and
 * match it. On a repository with no product that instruction has no referent,
 * and an agent asked to match patterns that do not exist invents screens and
 * then writes a spec about them. Knowing which case we are in is what lets the
 * prompt say "establish the conventions" instead of "match them".
 *
 * Read from git rather than the filesystem: an untracked node_modules is not a
 * product, and a checkout mid-build is not either.
 */
export function workspaceIsEmpty(dirs: string[]): boolean {
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) continue;
    const listed = spawnShellSync(`git -C ${shellQuote(dir)} ls-files`, {
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (listed.status !== 0) return false;
    const real = listed.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // mvpfy's own files are not the product: a workspace holding nothing but
      // a plan and a compose file it generated is still empty.
      .filter((l) => !/(^|\/)(mvpfy-|mvpfy\.yml|docker-compose\.mvpfy)/.test(l))
      .filter((l) => !l.startsWith('.mvpfy/'));
    if (real.length > 0) return false;
  }
  return true;
}

/** A plausible git remote: an https URL or an scp-style ssh address. */
export function isRemoteUrl(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  return /^https:\/\/[^/\s]+\/\S+$/.test(v) || /^(ssh:\/\/)?[\w.-]+@[^/\s:]+[:/]\S+$/.test(v);
}

/**
 * Start a product that does not exist yet.
 *
 * Until now a project had to come from somewhere: a repository to clone, or a
 * folder to link. Someone with an idea and no code had nowhere to begin, which
 * is the one case this app is most obviously for. This makes the repository
 * itself — initialised, committed, and ready to hold a worktree — so the first
 * feature can be planned against an empty workspace rather than a missing one.
 *
 * `remote` asks gh to create a private GitHub repository and push to it. It is
 * separate because it is the only part that leaves this machine, and a project
 * without it still works: everything but raising a pull request needs no
 * remote, and the raise explains itself when there is none.
 */
export function createBlankProject(
  name: string,
  remote: BlankProjectRemote
): CreateProjectResult & { remoteError?: string } {
  ensureDirs();
  const cleaned = name.trim();
  if (!cleaned) {
    return { ok: false, slug: '', workspacePath: '', repos: [], error: 'Give the project a name' };
  }
  const baseSlug = slugFromRepoUrl(cleaned);
  let slug = baseSlug;
  let n = 2;
  while (fs.existsSync(path.join(PROJECTS_DIR, slug))) slug = `${baseSlug}-${n++}`;
  const workspacePath = path.join(PROJECTS_DIR, slug);
  const q = shellQuote(workspacePath);

  fs.mkdirSync(workspacePath, { recursive: true });
  const init = spawnShellSync(`git -C ${q} init -b main`, { encoding: 'utf8', timeout: 20_000 });
  if (init.status !== 0) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    return {
      ok: false,
      slug,
      workspacePath,
      repos: [],
      error: `Could not create a git repository: ${(init.stderr || init.stdout || '').trim()}`,
    };
  }
  ensureInitialCommit(workspacePath);

  const repos = [{ url: '', dir: workspacePath, ok: true as const }];
  if (remote.kind === 'none') return { ok: true, slug, workspacePath, repos };

  // The project itself is fine whatever happens next — only the remote can
  // fail here. Saying so beats throwing away a working workspace over the one
  // part that can be added later with a single command.
  const withRemoteError = (message: string) => ({
    ok: true as const,
    slug,
    workspacePath,
    repos: [{ url: remote.kind === 'existing' ? remote.url : '', dir: workspacePath, ok: true }],
    remoteError: message,
  });

  if (remote.kind === 'existing') {
    const url = remote.url.trim();
    if (!isRemoteUrl(url)) {
      return withRemoteError(
        `"${url}" does not look like a git remote — expected https:// or git@`
      );
    }
    // Pushed rather than only wired up, so the answer to "did that work?" is
    // known now rather than at the first pull request. A repository with
    // anything already in it refuses here, which is the right moment to hear it.
    const wired = spawnShellSync(
      `git -C ${q} remote add origin ${shellQuote(url)} && git -C ${q} push -u origin HEAD`,
      { encoding: 'utf8', timeout: 120_000 }
    );
    if (wired.status !== 0) {
      return withRemoteError(
        (wired.stderr || wired.stdout || '').trim() || 'could not push to that repository'
      );
    }
    return { ok: true, slug, workspacePath, repos: [{ url, dir: workspacePath, ok: true }] };
  }

  // --source with --push wires origin and pushes main in one step, so a
  // half-made project cannot be left with a remote it never reached.
  const created = spawnShellSync(
    `gh repo create ${shellQuote(slug)} --private --source ${q} --remote origin --push`,
    { encoding: 'utf8', timeout: 120_000 }
  );
  if (created.status !== 0) {
    return withRemoteError(
      (created.stderr || created.stdout || '').trim() || 'gh could not create the repository'
    );
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
  for (const r of repos) ensureInitialCommit(r.dir);
  return { ok: true, slug: path.basename(src), workspacePath: src, repos };
}

/**
 * Shell command that pulls the latest changes into each repo directory, with
 * a heading per repo so the streamed log stays readable. Every directory must
 * be a managed or linked workspace path; anything else is rejected.
 */
/**
 * Read what each repository's checkout of a feature is holding.
 *
 * Every question here is asked of git rather than of any run's account of
 * itself. An agent that edited files and stopped before committing leaves work
 * that raising a pull request cannot see — it counts commits — so the feature
 * reports having nothing to raise while the changes sit a folder away. Same
 * for a merge that was interrupted: the next story run fails on it, with an
 * error about the merge rather than about anything the story did.
 */
export function featureGitStatus(
  dirs: string[],
  projectKey: string,
  featureSlug: string,
  branch: string
): FeatureRepoGit[] {
  const out: FeatureRepoGit[] = [];
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) continue;
    const tree = worktreePathFor(projectKey, featureSlug, dir);
    const has = fs.existsSync(tree);
    const q = shellQuote(has ? tree : dir);
    const ask = (command: string) =>
      spawnShellSync(`git -C ${q} ${command}`, { encoding: 'utf8', timeout: 15_000 });

    const status = has ? ask('status --porcelain') : null;
    const uncommitted =
      status?.status === 0
        ? status.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    const base = defaultBranchOf(dir);
    const onBranch = hasBranch(dir, branch);
    const trunk = trunkRefFor(dir, base);
    const ahead = onBranch ? commitsAhead(dir, base, branch) : 0;
    const behind = onBranch ? commitsBehind(dir, branch, trunk) : 0;
    // -1 rather than 0: a branch that was never pushed is a different answer
    // from one whose commits are all on the remote already.
    const pushedRange = ask(`rev-list --count ${shellQuote(`origin/${branch}..${branch}`)}`);
    const unpushed = pushedRange.status === 0 ? Number(pushedRange.stdout.trim()) || 0 : -1;
    const merge = has ? ask('rev-parse -q --verify MERGE_HEAD') : null;

    out.push({
      repo: dir,
      worktree: has ? tree : '',
      uncommitted,
      ahead: ahead < 0 ? 0 : ahead,
      behind,
      trunk,
      unpushed,
      mergeInProgress: merge?.status === 0,
    });
  }
  return out;
}

/**
 * Commit whatever a feature's checkouts are holding.
 *
 * Deliberately a run the builder starts rather than something that happens by
 * itself: this commits files nobody has read, and an agent that stopped before
 * committing may have stopped for a reason. `add -A` honours .gitignore, which
 * is the only thing standing between this and committing a stray env file — so
 * the caller shows what will be committed before offering the button.
 */
export function commitFeatureWorkCommand(
  dirs: string[],
  projectKey: string,
  featureSlug: string,
  branch: string,
  message: string
): string {
  const parts: string[] = [];
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) {
      throw new Error('Committing is restricted to managed and linked project directories');
    }
    const tree = worktreePathFor(projectKey, featureSlug, dir);
    if (!fs.existsSync(tree)) continue;
    const q = shellQuote(tree);
    parts.push(
      `echo ${shellQuote(`── ${path.basename(dir)}`)} && ` +
        // Nothing to commit is success: the other repositories still have work.
        `(git -C ${q} diff --quiet && git -C ${q} diff --cached --quiet && ` +
        `echo ${shellQuote('nothing uncommitted')} || ` +
        `(git -C ${q} add -A && git -C ${q} commit -m ${shellQuote(message)}))`
    );
  }
  if (parts.length === 0) {
    throw new Error(`No checkout of ${branch} to commit in — implement something first.`);
  }
  return parts.join(' && ');
}

/**
 * Merge the trunk into a feature's branch, in the feature's own checkout.
 *
 * The branch is checked out in the worktree, so the merge has to happen there —
 * the workspace copy is detached at one of its commits and cannot move it. What
 * the builder then tests is the feature ON TOP of what everyone else has
 * landed, rather than the feature as it was the day it was branched.
 *
 * The trunk is fetched first. Syncing the workspace pulls it, but a feature
 * that is not the one being tested can sit for a week while the trunk moves
 * underneath it, and "update this feature" has to mean the trunk as it is now —
 * not as it was when somebody last pulled. A repository with no remote, or a
 * remote that cannot be reached, still merges the local trunk: being unable to
 * ask is not a reason to do nothing.
 *
 * A conflict aborts. A worktree left half-merged breaks the next story run with
 * an error about an unfinished merge, which is a worse place to be than simply
 * not having merged yet — so it stops, cleanly, and says so.
 */
export function mergeTrunkCommand(
  projectKey: string,
  featureSlug: string,
  dirs: string[],
  branch: string,
  /**
   * What a conflict should leave behind. 'abort' puts the checkout back as it
   * was, which is right when nobody asked for a merge in particular — syncing
   * the workspace merges in passing, and a half-merged checkout nobody is
   * looking at breaks the next run in it. 'keep' leaves the conflict open for
   * whoever asked to resolve it, and is only ever used where something is
   * waiting to do exactly that.
   */
  onConflict: 'abort' | 'keep' = 'abort'
): string {
  const steps: Array<{ name: string; command: string; whenItFails: string }> = [];
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) {
      throw new Error('Merge is restricted to managed and linked project directories');
    }
    if (!hasBranch(dir, branch)) continue;
    const tree = worktreePathFor(projectKey, featureSlug, dir);
    if (!fs.existsSync(tree)) continue;
    const base = defaultBranchOf(dir);
    const ref = trunkRefFor(dir, base);
    const q = shellQuote(tree);
    const name = path.basename(dir);
    // A worktree shares its repository's object store and refs, so fetching
    // here updates origin/<base> for the workspace too, and neither the
    // workspace nor the branch it is standing on has to move for any of this.
    const fetch = hasOrigin(dir)
      ? `(git -C ${q} fetch origin ${shellQuote(base)} || echo ${shellQuote(
          `${name}: could not reach the remote — merging ${base} as it stands here`
        )}) && `
      : '';
    // Said in git's words above and in the feature's words here. A conflict is
    // the usual reason a merge stops; loose files in the checkout are the other
    // one, and neither is settled by the merge itself. Both branches of the
    // abort are spelled out because there is no separator that runs a second
    // command regardless on both shells.
    const stopped =
      onConflict === 'abort'
        ? `((git -C ${q} merge --abort && echo ${shellQuote(
            `${name}: could not merge ${ref} into ${branch} — git says why above. The checkout was left as it was; update the feature to have the conflicts resolved`
          )}) || echo ${shellQuote(
            `${name}: could not merge ${ref} into ${branch}, and undoing it did not work either — git says why above`
          )})`
        : `echo ${shellQuote(
            `${name}: ${ref} conflicts with ${branch} — git says which files above. Left open, in this checkout only, to be resolved`
          )}`;
    steps.push({
      name,
      // --no-edit: an editor opening on a merge message inside a spawned shell
      // is a run that never returns.
      command: `${fetch}(git -C ${q} merge --no-edit ${shellQuote(ref)} || ${stopped})`,
      whenItFails: `nothing was merged here — git says why above. Every other repository was still tried`,
    });
  }
  return chainPerRepo(steps);
}

/**
 * What is still conflicted in a feature's checkouts, read from git.
 *
 * A merge left open is not a state anything should be told about second-hand:
 * whether files are still conflicted decides whether the resolution is finished
 * or the merge has to be abandoned, and the only honest source for that is the
 * index itself.
 */
export function featureConflicts(
  dirs: string[],
  projectKey: string,
  featureSlug: string
): MergeConflicts[] {
  const out: MergeConflicts[] = [];
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) continue;
    const tree = worktreePathFor(projectKey, featureSlug, dir);
    if (!fs.existsSync(tree)) continue;
    const q = shellQuote(tree);
    const ask = (command: string) =>
      spawnShellSync(`git -C ${q} ${command}`, { encoding: 'utf8', timeout: 15_000 });
    if (ask('rev-parse -q --verify MERGE_HEAD').status !== 0) continue;
    const unmerged = ask('diff --name-only --diff-filter=U');
    out.push({
      repo: dir,
      worktree: tree,
      // A merge with nothing unmerged left is the finished-but-uncommitted
      // state, and belongs in this list as much as a conflicted one does.
      files:
        unmerged.status === 0
          ? unmerged.stdout
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
          : [],
    });
  }
  return out;
}

/**
 * Finish a merge that stopped on conflicts: commit the resolution, or abandon
 * it and leave the feature exactly as it was.
 *
 * Committing is guarded rather than trusted. Everything that could make this
 * commit land somewhere it does not belong, or record a resolution that is not
 * one, is read from git first and refused by name:
 *
 * • the checkout must still be on the feature's own branch, so a resolution
 *   can never be committed onto the trunk — the trunk is what everyone else is
 *   working from, and this whole operation must leave it untouched;
 * • nothing may still be unmerged, so "resolved" means git agrees;
 * • no tracked file may still hold conflict markers, because `git add` will
 *   happily mark a file resolved with them still in it.
 *
 * Only tracked files are staged (`add -u`): a resolution touches files that
 * already exist, and whatever else is loose in the checkout is not part of it.
 */
export function finishMergeCommand(
  projectKey: string,
  featureSlug: string,
  dirs: string[],
  branch: string,
  mode: 'commit' | 'abort'
): string {
  const steps: Array<{ name: string; command: string; whenItFails: string }> = [];
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) {
      throw new Error('Merging is restricted to managed and linked project directories');
    }
    const tree = worktreePathFor(projectKey, featureSlug, dir);
    if (!fs.existsSync(tree)) continue;
    const q = shellQuote(tree);
    const name = path.basename(dir);
    const ask = (command: string) =>
      spawnShellSync(`git -C ${q} ${command}`, { encoding: 'utf8', timeout: 15_000 });
    if (ask('rev-parse -q --verify MERGE_HEAD').status !== 0) continue;

    const goBack = (why: string) => ({
      name,
      command:
        `(git -C ${q} merge --abort && echo ${shellQuote(
          `${name}: ${why} — merge abandoned, so ${branch} is exactly as it was before it started`
        )})` +
        ` || echo ${shellQuote(
          `${name}: ${why}, and undoing the merge did not work either — git says why above`
        )}`,
      whenItFails: `${why} — and the merge could not be undone here`,
    });

    if (mode === 'abort') {
      steps.push(goBack('asked to go back'));
      continue;
    }

    // Each repository answers for itself. One of several failing its checks is
    // no reason to throw away a resolution another repository got right:
    // repositories merge independently, a clean merge in one is committed by
    // git before any of this runs, and undoing that to keep a symmetry git
    // never had would destroy work to look tidy.
    const on = ask('rev-parse --abbrev-ref HEAD');
    const at = on.status === 0 ? on.stdout.trim() : '';
    if (at !== branch) {
      // Never committed anywhere but the feature's own branch: the trunk is
      // what everyone else is working from, and this must not touch it.
      steps.push(goBack(`its checkout is on ${at || 'no branch'} rather than ${branch}`));
      continue;
    }
    const unmerged = ask('diff --name-only --diff-filter=U');
    const left =
      unmerged.status === 0
        ? unmerged.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    if (left.length > 0) {
      const named = left.slice(0, 3).join(', ');
      steps.push(
        goBack(
          `${left.length} file${left.length === 1 ? '' : 's'} could not be resolved (${named}${
            left.length > 3 ? ', …' : ''
          })`
        )
      );
      continue;
    }
    // `git add` will mark a file resolved with the markers still in it, so
    // "nothing unmerged" is not on its own evidence of a resolution.
    const markers = ask(`grep -l -e ${shellQuote('^<<<<<<< ')} -e ${shellQuote('^>>>>>>> ')} -- .`);
    if (markers.status === 0) {
      const file = markers.stdout.trim().split('\n')[0] ?? '';
      steps.push(goBack(`${file} still has conflict markers in it`));
      continue;
    }
    steps.push({
      name,
      // Only tracked files: a resolution touches files that already exist, and
      // whatever else is loose in the checkout is not part of it.
      command: `git -C ${q} add -u && git -C ${q} commit --no-edit && echo ${shellQuote(
        `${name}: merge committed on ${branch}`
      )}`,
      whenItFails: `the resolution could not be committed — git says why above, and the merge is still open here`,
    });
  }
  return chainPerRepo(steps);
}

export function pushFeatureBranchCommand(dirs: string[], branch: string): string {
  const steps: Array<{ name: string; command: string; whenItFails: string }> = [];
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) {
      throw new Error('Pushing is restricted to managed and linked project directories');
    }
    if (!hasBranch(dir, branch)) continue;
    if (!hasOrigin(dir)) continue;
    // The remote's copy has to exist for this to be an update of it.
    const known = spawnShellSync(
      `git -C ${shellQuote(dir)} rev-parse --verify --quiet ${shellQuote(`refs/remotes/origin/${branch}`)}`,
      { encoding: 'utf8', timeout: 10_000 }
    );
    if (known.status !== 0) continue;
    // And there has to be something in it the remote has not got.
    const count = spawnShellSync(
      `git -C ${shellQuote(dir)} rev-list --count ${shellQuote(`origin/${branch}..${branch}`)}`,
      { encoding: 'utf8', timeout: 10_000 }
    );
    if (count.status !== 0 || (Number(count.stdout.trim()) || 0) === 0) continue;
    steps.push({
      name: path.basename(dir),
      command: `git -C ${shellQuote(dir)} push origin ${shellQuote(branch)}`,
      whenItFails: `the remote copy of ${branch} would not take this push — git says why above. Nothing here was changed or lost, and every other repository was still pushed`,
    });
  }
  return chainPerRepo(steps);
}

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

/**
 * The trunk to measure against and merge: the remote's copy of it when this
 * repository has one fetched, and the local branch when it has not.
 *
 * The local trunk only moves when somebody pulls. A feature can be six commits
 * behind what everyone else has pushed while the local `main` says it is level,
 * and that is the number a PM is asking about.
 */
function trunkRefFor(dir: string, base: string): string {
  const res = spawnShellSync(
    `git -C ${shellQuote(dir)} rev-parse --verify --quiet ${shellQuote(`refs/remotes/origin/${base}`)}`,
    { encoding: 'utf8', timeout: 10_000 }
  );
  return res.status === 0 ? `origin/${base}` : base;
}

/** Commits `trunk` has that `branch` has not — what a merge would bring in. */
function commitsBehind(dir: string, branch: string, trunk: string): number {
  const res = spawnShellSync(
    `git -C ${shellQuote(dir)} rev-list --count ${shellQuote(`${branch}..${trunk}`)}`,
    { encoding: 'utf8', timeout: 10_000 }
  );
  // Unknown reads as level rather than as behind: offering to merge something
  // that could not be counted would be a button with nothing behind it.
  return res.status === 0 ? Number(res.stdout.trim()) || 0 : 0;
}

/**
 * Join one step per repository so that a repository failing cannot stop the
 * rest of them.
 *
 * `&&` is the only separator the user's shell and cmd.exe read the same way: a
 * bare `;` is just an argument on Windows, and `&` backgrounds the command on
 * POSIX. So the steps stay joined by `&&` and each one is made to succeed
 * instead — whatever went wrong is said in that repository's own words, in the
 * log, where the git output that explains it already is.
 *
 * The run therefore exits zero even when a repository failed, which is why
 * everything that reads these results reads git afterwards rather than an exit
 * code: with several repositories there is no single answer for one to carry.
 */
function chainPerRepo(
  steps: Array<{ name: string; command: string; whenItFails: string }>
): string {
  if (steps.length === 0) return '';
  return steps
    .map(
      (s) =>
        `(echo ${shellQuote(`── ${s.name}`)} && (${s.command})) || echo ${shellQuote(
          `${s.name}: ${s.whenItFails}`
        )}`
    )
    .join(' && ');
}

/** True when this repository has somewhere to fetch from. */
function hasOrigin(dir: string): boolean {
  return (
    spawnShellSync(`git -C ${shellQuote(dir)} remote get-url origin`, {
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

/** A title is one line by definition; a stray newline would split the command. */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * Push a feature branch and open its pull requests.
 *
 * A pull request with no commits cannot exist — GitHub rejects it outright — so
 * the branch is uniform across every repository but the pull requests are not.
 * Which repositories changed is decided here by counting commits, never by
 * asking the agent what it thinks it touched.
 *
 * `bodyFile` is a path, not the text. A pull request body is many lines, and a
 * multi-line argument cannot survive cmd.exe: a quoted string there ends at
 * the newline, so everything past the first line is read as fresh commands and
 * the whole chain collapses — which is why raising worked on macOS and failed
 * on Windows. `--body-file` keeps the text off the command line entirely.
 */
export function raisePrCommand(
  dirs: string[],
  branch: string,
  title: string,
  bodyFile: string
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
        `--title ${shellQuote(oneLine(title))} --body-file ${shellQuote(bodyFile)} || ` +
        `gh pr view ${shellQuote(branch)} --json url -q .url)`
      );
    })
    .join(' && ');
}

/**
 * The remote each repository actually points at, asked of git.
 *
 * Read rather than remembered, for the same reason the branch is: a project
 * records the URL it was created with, and a remote added by hand afterwards —
 * or changed, or removed — would leave that record describing something that
 * is no longer true. Empty means no origin, which is a normal state for a
 * project started from nothing.
 */
export function readRepoRemotes(dirs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!isAllowedWorkspace(dir)) continue;
    const res = spawnShellSync(`git -C ${shellQuote(dir)} remote get-url origin`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
    out[dir] = res.status === 0 ? res.stdout.trim() : '';
  }
  return out;
}

/**
 * Point a repository at a remote and push what it already has.
 *
 * Pushed, not merely wired up, for the same reason creating a project pushes:
 * `git remote add` always succeeds, so a wrong address or a repository someone
 * cannot write to would go unnoticed until the first pull request. A remote
 * with anything already in it refuses the push, which is the right moment to
 * hear about it.
 */
export function addRemoteCommand(dir: string, url: string): string {
  const resolved = path.resolve(dir);
  if (!isAllowedWorkspace(resolved)) {
    throw new Error('Remotes can only be set on managed and linked project directories');
  }
  const address = url.trim();
  if (!isRemoteUrl(address)) {
    throw new Error(`"${address}" does not look like a git remote — expected https:// or git@`);
  }
  const q = shellQuote(resolved);
  // Replaces an existing origin rather than failing on it: a project that was
  // pointed at the wrong place is exactly who needs this.
  const alsoRun = IS_WIN ? '&' : ';';
  return (
    `git -C ${q} remote remove origin ${alsoRun} ` +
    `git -C ${q} remote add origin ${shellQuote(address)} && ` +
    `git -C ${q} push -u origin HEAD`
  );
}

/**
 * Remove a feature's board: its plan, its spec, its designs, its checkouts.
 *
 * Deliberately not its branch, and deliberately not its commits. A board is
 * mvpfy's record of a feature; the work is in git and on GitHub, and removing
 * a card is not a decision to throw code away. A feature deleted by mistake
 * costs the planning; one that also deleted its branch would cost the work.
 */
export function deleteFeatureFiles(
  workspacePath: string,
  configDir: string,
  slug: string
): { removed: string[] } {
  const root = path.resolve(workspacePath);
  if (!isAllowedWorkspace(root)) {
    throw new Error('Features can only be removed from managed and linked project directories');
  }
  if (!slug.trim()) throw new Error('Refusing to remove the unnamed plan');
  const removed: string[] = [];
  const targets = [
    path.join(root, configDir, planFileFor(slug)),
    path.join(root, configDir, specFileFor(slug)),
    path.join(root, configDir, designDirFor(slug)),
  ];
  for (const target of targets) {
    // Every path is built from a slug that named a plan file; asserted anyway
    // because these reach rm.
    if (!target.startsWith(path.join(root, configDir))) {
      throw new Error('Refusing to remove outside the workspace');
    }
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(path.basename(target));
  }
  return { removed };
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
