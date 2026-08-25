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
  PROJECTS_DIR,
} from '../paths';
import { ideContainerName, spawnEnv } from './docker';
import { shellQuote, spawnShell, spawnShellSync } from './shell';

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
