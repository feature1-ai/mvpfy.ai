import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { SetupCommands, SetupIo } from './setup';

/**
 * Setup's terminal: the real one.
 *
 * Kept out of setup.ts so that file has no process, no stdin and no child in
 * it, and can be tested by handing it answers.
 */

export class TerminalIo implements SetupIo {
  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout
  ) {}

  say(text: string): void {
    this.output.write(`${text}\n`);
  }

  ask(question: string, options: { secret?: boolean } = {}): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: this.input,
        output: this.output,
        terminal: true,
      });
      if (options.secret) {
        // Echo nothing once the question is on screen: a token typed here
        // would otherwise sit in the scrollback and in any session recording.
        const write = this.output.write.bind(this.output);
        let asked = false;
        (rl as unknown as { _writeToOutput(text: string): void })._writeToOutput = (text) => {
          if (!asked) write(text);
          asked = true;
        };
      }
      let answered = false;
      const finish = (answer: string) => {
        if (answered) return;
        answered = true;
        if (options.secret) this.output.write('\n');
        resolve(answer);
      };
      // Input that ends before an answer — no terminal attached, or Ctrl-D —
      // is no answer. Left unresolved, the process would run out of things
      // to wait for and exit zero with setup unfinished.
      rl.once('close', () => finish(''));
      rl.question(question, (answer) => {
        finish(answer);
        rl.close();
      });
    });
  }
}

export class ShellSetupCommands implements SetupCommands {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  probe(command: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], {
        env: this.env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8');
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ code: null, stdout });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout });
      });
    });
  }

  interactive(command: string): Promise<number | null> {
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], { env: this.env, stdio: 'inherit' });
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code));
    });
  }
}
