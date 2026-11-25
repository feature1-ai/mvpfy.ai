import type { Project } from './types';
import { BOOTSTRAP_FILE, configDirFor } from './types';
import { watcherNote } from './watchers';

/**
 * The setup instructions, filled in for one project.
 *
 * Here rather than beside the desktop's other prompts so the headless worker
 * sets a product up from exactly the same words. The template's text is
 * handed in: the desktop bundles it, the worker reads it from disk.
 */

/**
 * Extra ground rules injected into prompts when the workspace is the user's
 * own folder used in place rather than a managed clone: everything mvpfy
 * writes stays inside .mvpfy/ so the repository root is never polluted.
 */
export const LINKED_NOTE =
  'IMPORTANT — this is a linked in-place repository (the user’s own working copy, not a ' +
  'managed clone). Every mvpfy file — mvpfy.yml, docker-compose.mvpfy.yml, env files ' +
  '(.env.mvpfy.example and the live env file), mvpfy-run.md, and every mvpfy-*.md/.json ' +
  'communication file — lives in the .mvpfy/ subfolder of the workspace root; read and ' +
  'write them THERE, never at the root. The compose file is invoked as `docker compose ' +
  '-f .mvpfy/docker-compose.mvpfy.yml --project-directory .` from the workspace root, so ' +
  'keep build contexts and host volume paths relative to the workspace root, and reference ' +
  'env files as .mvpfy/.env. If a repo needs a generated Dockerfile that does not already ' +
  'exist, write it as .mvpfy/Dockerfile.<repo> and point build.dockerfile at it; put ' +
  'generated mock services under .mvpfy/mocks/. Ensure .mvpfy/ is in .gitignore (add it if ' +
  'missing) and never commit anything under .mvpfy/.';

/**
 * Setup being run again on a project that already has generated files. Without
 * this the agent follows its reuse rule, sees a working compose file and
 * changes nothing — which is exactly the case where the PM asked for it to be
 * brought up to date.
 */
export const REGENERATE_NOTE =
  'IMPORTANT — this project was set up before, and the product manager has asked for its ' +
  'setup to be REGENERATED. The mvpfy-generated files here may come from an older version ' +
  'of mvpfy: do not reuse them just because they exist and appear to work. Rewrite ' +
  'docker-compose.mvpfy.yml, any Dockerfile you generated, and mvpfy.yml to what you would ' +
  'write today, backing each up to .bak first. Keep what is still working: the same host ' +
  'ports, the same service names where you can, the same demo credentials — carry those ' +
  'values across into the env and the seed so the login already on screen keeps working — ' +
  'and the existing env file and its values. NEVER delete or recreate a database volume — the product manager ' +
  'has data in it. Their app code is not yours to change.';

/**
 * A repository was added to a project whose environment already works.
 *
 * Deliberately not REGENERATE_NOTE. Regenerating rewrites the compose file,
 * the Dockerfiles and mvpfy.yml "to what you would write today" — which is
 * right when the setup is old and wrong when the only thing that changed is
 * that there is one more repository. A rewrite risks renaming a service or
 * a volume, and a renamed volume is a database the product manager can no
 * longer see. It also costs a full setup to add one service.
 *
 * So this says the opposite: the stack is correct, extend it.
 */
export function extendNoteFor(newRepos: string[]): string {
  if (newRepos.length === 0) return '';
  const names = newRepos.map((dir) => dir.split(/[/\\]/).pop() ?? dir);
  return (
    'IMPORTANT — this project is ALREADY SET UP and its environment works. The product ' +
    'manager has added ' +
    (names.length === 1 ? 'a repository' : `${names.length} repositories`) +
    ' to it, and your job is to EXTEND what is here, not to regenerate it:\n' +
    names.map((n) => `  • ${n}`).join('\n') +
    '\n' +
    'Work out what each new part is and what it needs to run, then ADD it:\n' +
    '• Edit docker-compose.mvpfy.yml in place. Add the new services. Do not rewrite the ' +
    'file, do not reorder it, and do not touch a service that is already in it.\n' +
    '• NEVER rename an existing service or an existing volume. A renamed volume is a ' +
    'database the product manager can no longer see, and the data is still on their disk ' +
    'under a name nothing points at.\n' +
    '• NEVER change a host port that is already allocated — something may be open in their ' +
    'browser right now. Give the new services ports that do not collide with any in use.\n' +
    '• Keep the existing env file and every value in it, and the demo credentials exactly ' +
    'as they are: the login on screen must keep working. Append new variables; change none.\n' +
    '• Add the new parts to mvpfy.yml alongside the existing ones rather than rewriting it.\n' +
    '• The images for everything already here ARE BUILT AND PRESENT on this machine. Do not ' +
    'rebuild them, do not change their build context or Dockerfile, and do not run anything ' +
    'that would tear them down. Only the new services need building, and bringing the stack ' +
    'up afterwards is enough to do that.\n' +
    '• If a new part needs nothing added — it is a library, or it is already covered — say ' +
    'so and change nothing. That is a good outcome, not a failure.\n' +
    'Their app code is not yours to change.'
  );
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  );
}

export interface SetupPromptInput {
  project: Pick<Project, 'mode' | 'localPath' | 'basePort' | 'reposPendingSetup'>;
  /** The product manager asked for setup to be done again from scratch. */
  regenerate: boolean;
  /** The machine the stack runs on, which decides how file watchers must work. */
  onWindows: boolean;
  /** How many host ports each project is given, from its base port. */
  portBlock: number;
}

export function buildSetupPrompt(template: string, input: SetupPromptInput): string {
  const { project, regenerate, onWindows, portBlock } = input;
  const extending = project.reposPendingSetup ?? [];
  return fillTemplate(template, {
    repoPath: project.localPath,
    basePort: String(project.basePort),
    portRangeEnd: String(project.basePort + portBlock - 1),
    workspaceNote: project.mode === 'linked' ? LINKED_NOTE : '',
    // Extending wins over regenerating: a project with a repository waiting
    // to be added is asking for that, not for its stack to be rewritten.
    regenerateNote:
      extending.length > 0 ? extendNoteFor(extending) : regenerate ? REGENERATE_NOTE : '',
    bootstrapFile: configDirFor(project.mode) + BOOTSTRAP_FILE,
    watcherNote: watcherNote({ workspacePath: project.localPath, onWindows }),
  });
}
