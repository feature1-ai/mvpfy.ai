import { DEFAULT_STACK } from '../../shared/types';

/**
 * What the agent should read before it writes anything.
 *
 * Every planning and implementation prompt used to open by telling the agent to
 * study the existing product and match its patterns. That is right for the case
 * mvpfy was built for — a product that exists, being extended — and it is
 * meaningless on a repository with nothing in it. An agent told to match
 * patterns that do not exist does not stop; it invents screens and then writes
 * a spec that references them, and the product manager reads a plan about a
 * product nobody has.
 *
 * So the instruction is chosen rather than assumed, and the empty case is told
 * what it is: nothing to match, conventions to establish, and a stack to
 * establish them in.
 */

/** The stack an empty workspace is built in. Settings first, else the default. */
export function stackFor(configured: string | undefined | null): string {
  const chosen = (configured ?? '').trim();
  return chosen || DEFAULT_STACK;
}

export interface Grounding {
  /** No repository in the workspace holds a product yet. */
  empty: boolean;
  /** Settings.defaultStack — blank falls back to DEFAULT_STACK. */
  stack?: string;
  /**
   * The map of the code this feature's planning run wrote. Present for a
   * feature planned since notes existed; absent for one planned before, which
   * must still implement, so the old instruction stays as the fallback.
   */
  notesFile?: string;
}

/** The opening instruction for a spec run (mvpfy's own or a Feature1 pull). */
export function specGrounding({ empty, stack }: Grounding): string {
  if (!empty) {
    return (
      'Study the existing product in the workspace (code, routes, UI, README) so the spec ' +
      'fits what already exists — reference real screens and flows, never invented ones.'
    );
  }
  return (
    'This workspace has no product in it yet — the repository is empty. There are no ' +
    'screens, routes or flows to reference, so do not write as though there are: every ' +
    'screen this feature needs is one this feature creates, and the spec should say so ' +
    'plainly. Describe what the product manager will be able to do when it is built, not ' +
    'how it fits into something already there.\n' +
    `When it is implemented it will be built with ${stackFor(stack)}, so keep the spec ` +
    'within what that can do. Do not name it in the spec — the product manager reads this, ' +
    'and the stack is not their decision to review.'
  );
}

/**
 * The opening instruction for implementing one story.
 *
 * Telling every story to go and study the product meant a feature of six
 * stories studied the same codebase six times, each one paying to rediscover
 * where things are. The run that planned the feature had already read all of
 * it, so it now writes down what it found and the stories read that instead.
 *
 * The map replaces the search, not the reading: a story still opens the files
 * it is about to change, because the notes say where to look and never what
 * the code says. Notes that have gone stale therefore cost a wrong first guess
 * and not a wrong implementation.
 */
export function implementGrounding({ empty, stack, notesFile }: Grounding): string {
  if (!empty) {
    if (!notesFile) {
      return 'Look at how the product already does similar things and match its patterns.';
    }
    return (
      `Read ${notesFile} first — the run that planned this feature already read this ` +
      'product and wrote down where things are, what the conventions are, and which ' +
      'files this story is expected to touch. Start from that map instead of searching ' +
      'the workspace for it again.\n' +
      '   Then open the files it points you at and read those properly: the map says ' +
      'where to look, not what the code says. If it turns out to be wrong or ' +
      'incomplete, trust the code, carry on, and correct that part of ' +
      `${notesFile} as you go so the next story is not misled the same way.`
    );
  }
  return (
    'There is no product here yet: this is the first code in an empty repository, so ' +
    'there are no patterns to match and you are setting them. Build it with ' +
    `${stackFor(stack)}.\n` +
    '   Set up only what this story actually needs to run and be tested — a skeleton that ' +
    'works end to end beats a scaffold of empty folders. Include the project files a ' +
    'working repository has: dependency manifests, a test command that runs, a README ' +
    'saying how to start it, and a .gitignore. Choose the conventions deliberately — ' +
    'folder layout, naming, error handling, how tests are written — because every later ' +
    'story is told to match them.' +
    (notesFile
      ? `\n   Then write what you chose into ${notesFile}, under the headings it already ` +
        'has: where things are, the conventions, the one existing file to copy for each. ' +
        'Every later story reads that file instead of working your choices out from the ' +
        'code, so a convention you do not write down is one the next story will not keep.'
      : '')
  );
}
