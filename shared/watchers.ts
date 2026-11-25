/**
 * Whether an edit on the host reaches the file watcher inside the container,
 * and what to tell the bootstrap agent to do about it.
 *
 * This is the one environment fact the generated stack cannot be written
 * without, because getting it wrong is silent both ways. Poll where events
 * arrive and you have spent a core re-stating a tree that would have told you;
 * trust events where they do not arrive and the product manager edits a file,
 * the running app never changes, and nothing in any log says why.
 *
 * The answer is not the same on every machine mvpfy runs on:
 *
 * - macOS: events arrive. Verified by experiment rather than from
 *   documentation — an alpine container running `inotifywait -m -r` against
 *   the bind mount, with a write from inside the container as the control to
 *   prove the harness itself worked. A host write produced events.
 * - Linux: a bind mount is the host's own filesystem, so inotify is inotify.
 * - Windows, repository on a Windows drive: no events, ever. Docker's own
 *   guidance is explicit — "Linux containers only receive file change events
 *   when the original files live in the Linux filesystem" — and the reason is
 *   that the drive reaches the VM over 9P, where inotify_add_watch succeeds
 *   and then delivers nothing. This is the case mvpfy puts every Windows user
 *   in today, because it clones to ~/.mvpfy, which is C:\Users\…
 *
 * A Windows repository inside the WSL2 filesystem would be the fourth case and
 * is deliberately not guessed at here: no such workspace exists yet, since
 * nothing creates one, and the answer wants measuring on a Windows machine
 * before a stack is generated on the strength of it.
 */

/** `C:\…` or `D:/…` — a Windows drive, as opposed to a Linux path or a UNC share. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * @param input.workspacePath - where the repository is checked out, which is
 *   what gets bind-mounted.
 * @param input.onWindows - whether the host running mvpfy is Windows.
 */
export function hostEditsReachContainer(input: {
  workspacePath: string;
  onWindows: boolean;
}): boolean {
  return !(input.onWindows && WINDOWS_DRIVE.test(input.workspacePath));
}

/**
 * The rule as it was until Windows was looked at properly. Correct on macOS
 * and Linux, and worth stating as forcefully as this: polling is the reflex
 * fix for a watcher that looks broken, and on these machines it makes a fast
 * stack slow for no benefit at all.
 */
const NO_POLLING = `• Do NOT turn on polling file watchers. CHOKIDAR_USEPOLLING, WATCHPACK_POLLING,
  WATCHFILES_FORCE_POLLING, --poll: every one of them makes the watcher re-stat the whole
  tree several times a second, which on a large repository is a pegged core, a hot laptop,
  and a slower app than no watcher at all. They are a workaround for an environment where
  host edits do not reach the container, and this machine is not one — an edit on the host
  is delivered into the container, so the framework's own watcher sees it unaided. Use the
  native watcher, and if a watcher genuinely misses changes, say so in mvpfy-run.md rather
  than reaching for polling.`;

/**
 * Windows, repository on a Windows drive. Polling is not a preference here, it
 * is the only thing that works — so this says so in those terms, and spends
 * most of its length on keeping the cost down, because an unbounded poller is
 * how "it reloads now" becomes "the laptop is unusable".
 */
const POLLING = `• This machine REQUIRES polling file watchers — this is not a preference, and the stack
  does not work without it. The repository is on a Windows drive, which reaches the
  container over a filesystem that delivers no file-change notifications at all:
  inotify_add_watch succeeds and no event is ever delivered. A native watcher therefore
  sees nothing, every edit appears to do nothing, and no log says why. Turn polling on for
  whichever watcher the stack actually uses:
    - chokidar (vite, nodemon, webpack-dev-server): CHOKIDAR_USEPOLLING=true and
      CHOKIDAR_INTERVAL=300
    - webpack or Next.js: WATCHPACK_POLLING=true
    - uvicorn, or anything built on watchfiles: WATCHFILES_FORCE_POLLING=true
    - Rails: config.file_watcher = ActiveSupport::FileUpdateChecker
    - Go air: poll = true in .air.toml
  Set them under \`environment:\` on the service that runs the watcher, not baked into the
  image, so the next person to read the stack can see it is a host workaround rather than a
  property of the app. Polling costs CPU in proportion to the number of files it walks, so
  the ignore rule below is what makes it affordable rather than optional: a poller that
  recurses into node_modules or .git is exactly the pegged-core case. Record in
  mvpfy-run.md that polling is on because the repository sits on a Windows drive.`;

/** The watcher rules for this machine, for {watcherNote} in the bootstrap prompt. */
export function watcherNote(input: { workspacePath: string; onWindows: boolean }): string {
  return hostEditsReachContainer(input) ? NO_POLLING : POLLING;
}
