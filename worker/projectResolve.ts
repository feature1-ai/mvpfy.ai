import { Project, ProjectError, projectFrom } from './project';

/**
 * Which repositories a build is in, from Feature1, when nobody has said.
 *
 * Feature1 knows each project's repositories: they are what it was connected
 * to. So a build of a story is in the repositories of the story's project,
 * read through Feature1's MCP server, and a workspace with several projects
 * builds each one's work in its own. A runner told its repositories
 * (`project …`, or Settings in the web app) uses those instead: that is how a
 * project whose repositories Feature1 has wrong or incomplete is put right.
 *
 * What Feature1 says is checked against GitHub before anything is cloned: a
 * repository the runner's account cannot push to is refused here, not an
 * hour later; a branch that is not there is replaced by the repository's own
 * default, and the log says so.
 */

export interface ListedRepository {
  name: string;
  url: string;
  branch: string | null;
  status: string;
}

/** The repositories `get_repository_context` lists, from the text it writes. */
export function repositoriesIn(markdown: string): ListedRepository[] {
  return markdown
    .split(/\n(?=### )/)
    .map((block) => ({
      name: block.match(/^### (.+)$/m)?.[1]?.trim() ?? '',
      url: block.match(/^\*\*URL\*\*: (\S+)/m)?.[1] ?? '',
      branch: block.match(/^\*\*Branch\*\*: (\S+)/m)?.[1] ?? null,
      status: block.match(/^\*\*Status\*\*: (\S+)/m)?.[1] ?? '',
    }))
    .filter((r) => /^https:\/\//.test(r.url));
}

export interface GithubRepository {
  defaultBranch: string;
  canPush: boolean;
}

export interface ResolveDeps {
  /** The project's repositories, as Feature1 lists them. */
  list: (projectId: string) => Promise<ListedRepository[]>;
  /** What GitHub says of a repository; null when it is not there for this account. */
  github: (owner: string, repo: string) => Promise<GithubRepository | null>;
  branchExists: (owner: string, repo: string, branch: string) => Promise<boolean>;
  log: (line: string) => void;
}

const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export async function projectFromFeature1(
  projectId: string | null,
  what: string,
  deps: ResolveDeps
): Promise<Project> {
  if (!projectId) {
    throw new ProjectError(
      `Feature1 does not say which project ${what} belongs to, so its repositories are not known. ` +
        'Set them in Settings → Repositories.'
    );
  }
  const listed = await deps.list(projectId);
  const active = listed.filter((r) => !r.status || r.status === 'active');
  if (active.length === 0) {
    throw new ProjectError(
      listed.length
        ? `None of the repositories Feature1 has for ${what}'s project is active. Set them in Settings → Repositories.`
        : `Feature1 has no repositories connected to ${what}'s project. Connect one in Feature1, or set them in Settings → Repositories.`
    );
  }
  const chosen: string[] = [];
  for (const repo of active) {
    const github = repo.url.match(GITHUB);
    if (!github) {
      // Not GitHub: nothing to ask ahead of the clone.
      chosen.push(`${repo.url}#${repo.branch ?? 'main'}`);
      continue;
    }
    const [, owner = '', name = ''] = github;
    const found = await deps.github(owner, name);
    if (!found) {
      throw new ProjectError(
        `${owner}/${name}, which Feature1 lists for ${what}, is not on GitHub for the runner's account. ` +
          'Check the GitHub account the runner is signed in with, or set the repositories in Settings.'
      );
    }
    if (!found.canPush) {
      throw new ProjectError(
        `The runner's GitHub account can read ${owner}/${name} but not push to it, so it could not open a pull request.`
      );
    }
    let branch = repo.branch ?? found.defaultBranch;
    if (branch !== found.defaultBranch && !(await deps.branchExists(owner, name, branch))) {
      deps.log(
        `Feature1 says ${owner}/${name} builds from ${branch}, which GitHub does not have; building from ${found.defaultBranch}, its default.`
      );
      branch = found.defaultBranch;
    }
    chosen.push(`${repo.url}#${branch}`);
  }
  return projectFrom(chosen);
}

/** The projects `list_projects` names: each one's id, name and how many repositories it has. */
export function projectsIn(
  markdown: string
): Array<{ id: string; name: string; repositories: number | null }> {
  return markdown
    .split(/\n(?=\d+\. \*\*)/)
    .map((block) => {
      const count = block.match(/^\s*- repositories: (\d+)/m)?.[1];
      return {
        id: block.match(/project_id: `([0-9a-f-]{36})`/i)?.[1] ?? '',
        name: block.match(/^\d+\. \*\*(.+?)\*\*/m)?.[1] ?? '',
        repositories: count === undefined ? null : Number(count),
      };
    })
    .filter((p) => p.id);
}

/**
 * Before anything has been built, which project to set up for test links:
 * the workspace's one project with repositories. With several, which one is
 * not a guess to make; the first build says.
 */
export async function onlyProject(
  projects: Array<{ id: string; name: string; repositories: number | null }>,
  hasRepositories: (projectId: string) => Promise<boolean>
): Promise<{ id: string; name: string }> {
  const withRepos: Array<{ id: string; name: string }> = [];
  for (const project of projects) {
    if (project.repositories === 0) continue;
    if (project.repositories === null && !(await hasRepositories(project.id))) continue;
    withRepos.push(project);
  }
  const [only] = withRepos;
  if (!only) {
    throw new ProjectError(
      'No project in Feature1 has a repository connected. Connect one in Feature1, or set the repositories in Settings.'
    );
  }
  if (withRepos.length > 1) {
    throw new ProjectError(
      `Feature1 has several projects with repositories (${withRepos.map((p) => p.name).join(', ')}). ` +
        'Build an item first, so mvpfy knows which to set up, or set the repositories in Settings.'
    );
  }
  return only;
}

/** GitHub's own answers, with the runner's token. */
export function githubWith(token: string | null, fetchImpl: typeof fetch = fetch) {
  const get = (path: string) =>
    fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'mvpfy-worker',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
  return {
    github: async (owner: string, repo: string): Promise<GithubRepository | null> => {
      const response = await get(`/repos/${owner}/${repo}`);
      if (response.status === 404 || response.status === 403 || response.status === 401)
        return null;
      if (!response.ok)
        throw new ProjectError(`GitHub answered ${response.status} for ${owner}/${repo}`);
      const body = (await response.json()) as {
        default_branch?: string;
        permissions?: { push?: boolean };
      };
      return {
        defaultBranch: body.default_branch || 'main',
        canPush: body.permissions?.push === true,
      };
    },
    branchExists: async (owner: string, repo: string, branch: string): Promise<boolean> => {
      const response = await get(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
      return response.ok;
    },
  };
}
