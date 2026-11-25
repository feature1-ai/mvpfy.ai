import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExecutionRepository } from '../shared/runner/contract';
import { UUID, validCloneUrl, validRef } from '../shared/runner/validate';

/**
 * The project a runner builds: which repositories, from which branches.
 *
 * When Feature1 hands work to a runner it names the repositories itself. A
 * runner that pulls a feature has nobody to tell it, so it is told once —
 * `project <repository>…` — and keeps the answer here, on its own volume. It
 * is the cloud's version of pointing the desktop app at a folder.
 *
 * No credential is kept in it: a repository address with one in it is refused.
 */

export class ProjectError extends Error {}

export interface Project {
  repositories: ExecutionRepository[];
}

const FILE = 'project.json';

/**
 * A stable UUID for something that has no UUID of its own.
 *
 * The worker's disk layout and its contract key everything by UUID. A
 * repository named by its address needs the same id every time, or each run
 * would clone it afresh under a new name.
 */
export function uuidFor(value: string): string {
  if (UUID.test(value)) return value.toLowerCase();
  const hex = crypto.createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** `https://github.com/acme/api.git#develop`. The branch defaults to `main`. */
export function repositoryFrom(argument: string): ExecutionRepository {
  const [address = '', branch = 'main', ...rest] = argument.trim().split('#');
  const url = address.trim();
  if (rest.length > 0 || !validCloneUrl(url)) {
    throw new ProjectError(
      `${JSON.stringify(argument)} is not a repository this runner can use. Give its https ` +
        'address with no credential in it, optionally followed by #branch.'
    );
  }
  if (!validRef(branch)) {
    throw new ProjectError(`${JSON.stringify(branch)} is not a usable branch name`);
  }
  const name =
    url
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .split('/')
      .pop() || 'repository';
  return { id: uuidFor(url.toLowerCase()), name, url, base_branch: branch };
}

export function projectFrom(args: string[]): Project {
  if (args.length === 0) throw new ProjectError('Name at least one repository');
  if (args.length > 20) throw new ProjectError('A project has at most 20 repositories');
  const repositories = args.map(repositoryFrom);
  const ids = new Set(repositories.map((repo) => repo.id));
  if (ids.size !== repositories.length) throw new ProjectError('A repository is named twice');
  return { repositories };
}

function parse(content: string): Project | null {
  try {
    const raw = JSON.parse(content) as { repositories?: unknown };
    if (!Array.isArray(raw.repositories) || raw.repositories.length === 0) return null;
    // Read back through the same checks it was written through: a file on a
    // volume is not trusted for having been written by an earlier version.
    return projectFrom(
      raw.repositories.map((repo) => {
        const { url, base_branch: branch } = (repo ?? {}) as Record<string, unknown>;
        return `${String(url ?? '')}#${String(branch ?? 'main')}`;
      })
    );
  } catch {
    return null;
  }
}

export class ProjectStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error('The worker root must be an absolute path');
  }

  get file(): string {
    return path.join(this.root, FILE);
  }

  load(): Project | null {
    try {
      return parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  save(project: Project): void {
    fs.mkdirSync(this.root, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(project, null, 2)}\n`);
    fs.renameSync(temporary, this.file);
  }
}

/** A project as a person reads it. */
export function describeProject(project: Project): string {
  return project.repositories
    .map((repo) => `  ${repo.name}  ${repo.url}  (from ${repo.base_branch})`)
    .join('\n');
}
