import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { featureExecution } from '../shared/runner/fixtures';
import { commandFrom } from './config';
import { doctorLines, runDoctor } from './doctor';
import { readGuidance } from './guidance';
import { buildPrompt, guidanceBlock } from './prompt';

describe('testing a runner', () => {
  it('asks every check, even after one fails, and reports each', async () => {
    const results = await runDoctor([
      { name: 'GitHub', run: async () => 'Signed in' },
      {
        name: 'Claude Code',
        run: async () => {
          throw new Error('Not signed in. Run setup.');
        },
      },
      { name: 'Sandbox', run: async () => 'Answers' },
    ]);
    expect(results).toEqual([
      { name: 'GitHub', ok: true, detail: 'Signed in' },
      { name: 'Claude Code', ok: false, detail: 'Not signed in. Run setup.' },
      { name: 'Sandbox', ok: true, detail: 'Answers' },
    ]);
    expect(doctorLines(results)[1]).toBe(
      'CHECK {"name":"Claude Code","ok":false,"detail":"Not signed in. Run setup."}'
    );
  });

  it('does not wait for ever on a check that hangs', async () => {
    const [result] = await runDoctor(
      [{ name: 'Engine', run: () => new Promise<string>(() => {}) }],
      20
    );
    expect(result).toMatchObject({ name: 'Engine', ok: false });
    expect(result?.detail).toMatch(/no answer/);
  });

  it('is its own command', () => {
    expect(commandFrom(['n', 'i', 'doctor'])).toEqual({ name: 'doctor' });
  });
});

describe("the team's guidance", () => {
  it('reaches every story, below the requirements in authority', () => {
    const execution = featureExecution();
    const unit = execution.snapshot.stories![0]!;
    const prompt = buildPrompt({
      execution,
      worktrees: {},
      questionsFile: '/q.md',
      unit,
      guidance: 'Use the existing Button component.\nServer code lives in server/services.',
    });
    expect(prompt).toContain("The team's design principles and architecture");
    expect(prompt).toContain('Use the existing Button component.');
    expect(prompt).toContain('the requirements win');
    expect(buildPrompt({ execution, worktrees: {}, questionsFile: '/q.md', unit })).not.toContain(
      "team's design principles"
    );
    expect(guidanceBlock('   ')).toBe('');
  });

  it('is read from the worker volume, and absent when nothing was written', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-guidance-'));
    expect(readGuidance(root)).toBeUndefined();
    fs.writeFileSync(path.join(root, 'guidance.md'), '  Mobile first.\n');
    expect(readGuidance(root)).toBe('Mobile first.');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
