import {
  ComponentLibrary,
  detectComponentLibraries,
  manifestCandidates,
} from '../../shared/componentLibraries';
import type { Project } from '../../shared/types';

/** A repository's folder inside the workspace: '' when it is the workspace. */
function folderOf(project: Pick<Project, 'localPath'>, dir: string): string | null {
  const root = project.localPath.replace(/[\\/]+$/, '');
  const repo = dir.replace(/[\\/]+$/, '');
  if (repo === root) return '';
  if (!repo.startsWith(root)) return null;
  const rest = repo.slice(root.length);
  return /^[\\/]/.test(rest) ? rest.slice(1).replace(/\\/g, '/') : null;
}

/**
 * The component libraries this project's repositories declare.
 *
 * Never throws and never guesses: a workspace that cannot be read has no
 * libraries as far as anyone downstream is concerned, and the agent is then
 * told nothing rather than something untrue.
 */
export async function componentLibrariesFor(
  project: Pick<Project, 'localPath' | 'repos'>
): Promise<ComponentLibrary[]> {
  const folders = project.repos
    .map((repo) => folderOf(project, repo.dir))
    .filter((folder): folder is string => folder !== null);
  const paths = [...new Set((folders.length > 0 ? folders : ['']).flatMap(manifestCandidates))];
  try {
    const files = await window.mvpfy.readRepoFiles(project.localPath, paths);
    return detectComponentLibraries(
      files
        .filter((file) => file.exists && file.content)
        .map((file) => ({ path: file.relativePath, content: file.content ?? '' }))
    );
  } catch {
    return [];
  }
}
