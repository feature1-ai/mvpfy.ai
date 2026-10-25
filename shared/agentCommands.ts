import { DEFAULT_STATE, RunAgentRequest } from './types';

/**
 * How the coding agents are invoked, in one place.
 *
 * Lifted out of the Electron service so the headless worker can build the
 * same commands without importing anything that belongs to the desktop app.
 * The flag assembly is the part worth sharing: the order matters to both
 * CLIs, and two copies would drift the first time one of them changes.
 *
 * Quoting is injected rather than assumed, because the two callers genuinely
 * differ. The desktop runs commands through the user's own shell, which is
 * cmd.exe on Windows; the worker always runs through /bin/sh. A single
 * platform-sensitive quote would be wrong for one of them.
 */
export interface CommandShell {
  quote(value: string): string;
  cd(dir: string): string;
}

export const posixShell: CommandShell = {
  quote: (value) => `'${value.replace(/'/g, `'\\''`)}'`,
  cd: (dir) => `cd '${dir.replace(/'/g, `'\\''`)}'`,
};

/**
 * The claude invocation for one run. Pure, so the flag assembly — three
 * optional flags whose order matters to the CLI — can be tested without
 * spawning anything.
 */
/**
 * What claude may do on a read-only run: look, never change. In print mode a
 * tool outside this list is refused outright rather than asked about, so the
 * list is the whole of what it can do.
 */
export const CLAUDE_READ_ONLY_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'LS',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(ls:*)',
];

export function claudeCommandFor(
  req: Pick<RunAgentRequest, 'model' | 'session' | 'readOnly'>,
  opts: { repoPath: string; promptFile: string; mcpConfig?: string },
  shell: CommandShell
): string {
  const q = shell.quote;
  const mcpFlag = opts.mcpConfig ? `--mcp-config ${q(opts.mcpConfig)} ` : '';
  // No --model unless one was chosen: claude then uses the model the user has
  // already configured, which never goes stale as the models change.
  const modelFlag = req.model ? `--model ${q(req.model)} ` : '';
  // --session-id names the conversation on the run that opens it; --resume
  // continues it. mvpfy chooses the id, so the two always agree.
  const sessionFlag = req.session
    ? req.session.resume
      ? `--resume ${q(req.session.id)} `
      : `--session-id ${q(req.session.id)} `
    : '';
  const permissions = req.readOnly
    ? `--permission-mode default --allowedTools ${q(CLAUDE_READ_ONLY_TOOLS.join(' '))} `
    : '--dangerously-skip-permissions ';
  return (
    `${shell.cd(opts.repoPath)} && claude ${mcpFlag}${modelFlag}${sessionFlag}` +
    `-p --verbose --output-format stream-json ${permissions}` +
    `< ${q(opts.promptFile)}`
  );
}

/**
 * The codex invocation for one run.
 *
 * Codex cannot be told which id to give a new conversation, only which
 * existing one to continue — so a first run opens a thread and the id is read
 * out of the stream, where `codex exec --json` announces it on the first line
 * as `thread.started`. Every run after that resumes it.
 *
 * `resume` takes the prompt as an argument or on stdin exactly as `exec`
 * does, so the two differ only in the subcommand and the id.
 */
export function codexCommandFor(
  req: Pick<RunAgentRequest, 'model' | 'session' | 'images' | 'readOnly'>,
  opts: { repoPath: string; promptFile: string; mcpFlag?: string },
  shell: CommandShell
): string {
  const q = shell.quote;
  // No model named means codex uses its own configured one, which is the
  // only choice that cannot be wrong about somebody else's account.
  const model = (req.model || DEFAULT_STATE.settings.codexModel).trim();
  const modelFlag = model ? `--model ${q(model)} ` : '';
  // Codex attaches images to the prompt rather than opening them from a
  // path, so a design has to be handed over as arguments. The prompt names
  // the same files regardless, which is what Claude Code reads.
  const imageFlags = (req.images ?? []).map((f) => `--image ${q(f)} `).join('');
  // Only ever resume: an id mvpfy invented would name no thread, and codex
  // would open a fresh one under a different id without saying so.
  // `resume` goes last, right before the prompt: it accepts only a few options
  // of its own and rejects --sandbox, so the exec options have to precede it.
  const resume = req.session?.resume ? `resume ${q(req.session.id)} ` : '';
  return (
    `${shell.cd(opts.repoPath)} && codex exec ${opts.mcpFlag ?? ''}${imageFlags}` +
    `${modelFlag}--sandbox ${req.readOnly ? 'read-only' : 'danger-full-access'} ` +
    `--skip-git-repo-check --json ${resume}- < ${q(opts.promptFile)}`
  );
}
