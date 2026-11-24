import { describe, expect, it } from 'vitest';
import type { UnitCheckSpec } from '../../shared/agentUnits';
import type { Project } from '../../shared/types';
import { buildSetupUnits } from './setupUnits';

const project = (mode?: 'linked'): Project =>
  ({
    id: 'p',
    localPath: '/w/shop',
    basePort: 4100,
    repos: [],
    generatedFiles: [],
    ...(mode ? { mode } : {}),
  }) as unknown as Project;

const INSTRUCTIONS = 'THE COMPLETE SETUP INSTRUCTIONS';
const units = (mode?: 'linked') => buildSetupUnits(project(mode), INSTRUCTIONS);
const checksOf = (id: string, mode?: 'linked'): UnitCheckSpec[] =>
  units(mode).find((u) => u.id === id)?.checks ?? [];

describe('the steps of setup', () => {
  const IDS = ['containers', 'environment', 'manifest', 'database', 'demo-login', 'handover'];

  it('are these six, in this order', () => {
    expect(units().map((u) => u.id)).toEqual(IDS);
  });

  it('have the same ids for every kind of project, because a retry finds its place by them', () => {
    // Renaming one makes every project half-way through setup start again.
    expect(units('linked').map((u) => u.id)).toEqual(IDS);
  });

  it('each give a new agent the complete instructions, after a note saying which part is its', () => {
    for (const [index, unit] of units().entries()) {
      expect(unit.promptText.endsWith(INSTRUCTIONS)).toBe(true);
      expect(unit.promptText).toContain(`THIS RUN IS STEP ${index + 1} OF 6 OF SETUP`);
      expect(unit.promptText.indexOf('do only this')).toBeLessThan(
        unit.promptText.indexOf(INSTRUCTIONS)
      );
    }
  });

  it('each give an agent already in the conversation only what this step is', () => {
    for (const [index, unit] of units().entries()) {
      const brief = unit.resumeText ?? '';
      expect(brief).toContain(`THIS RUN IS STEP ${index + 1} OF 6 OF SETUP`);
      expect(brief).not.toContain(INSTRUCTIONS);
      // The instructions stand; the earlier step notes do not.
      expect(brief).toContain('still apply in full');
      expect(brief).toContain('REPLACES the step note of every');
    }
  });

  it('say the same thing about the step in both briefs', () => {
    for (const unit of units()) {
      const firstLineOfScope = unit.promptText.split('do only this:')[1].trim().split('\n')[0];
      expect(unit.resumeText).toContain(firstLineOfScope.trim());
    }
  });

  it('tell each run what was already done and what to leave alone', () => {
    const all = units();
    expect(all[0].promptText).toContain('This is the first step');
    expect(all[0].promptText).toMatch(/Do NOT write them now[\s\S]*the env files/);
    expect(all[1].promptText).toContain('• Give every part of your product a container');
    expect(all[2].promptText).toMatch(/Do NOT write them now[\s\S]*seed_command/);
    expect(all[5].promptText).toContain('This is the last step');
    expect(all[5].promptText).not.toContain('Do NOT write them now');
  });

  it('keep the seed a start-up step that mvpfy can show the login for', () => {
    const seed = units().find((u) => u.id === 'demo-login')?.promptText ?? '';
    expect(seed).toContain('STARTING UP');
    expect(seed).toContain('idempotent');
    expect(seed).toContain('MVPFY_DEMO_EMAIL');
  });

  it('never let the database step destroy data, in either brief', () => {
    const database = units().find((u) => u.id === 'database');
    const rule = 'Never drop, reset or recreate a database that already holds data';
    expect(database?.promptText).toContain(rule);
    expect(database?.resumeText).toContain(rule);
  });

  it('leave a card that spans steps for the run that finishes it', () => {
    expect(units()[0].promptText).toContain('mvpfy-bootstrap.json');
    expect(units()[0].promptText).toContain('stays in "doing"');
  });
});

describe('what mvpfy looks for after each step', () => {
  it('looks for the stack file after the containers step, before Docker can judge it', () => {
    // Docker refuses a stack whose env file is not there yet, so asking it
    // here would fail a step for work that belongs to the next one.
    expect(checksOf('containers')).toEqual([
      { kind: 'files', paths: ['docker-compose.mvpfy.yml'] },
    ]);
  });

  it('asks Docker about the stack once the env files exist', () => {
    expect(checksOf('environment')).toEqual([
      { kind: 'files', paths: ['.env.mvpfy.example', '.env'] },
      { kind: 'compose-config', linked: false },
    ]);
  });

  it('checks the manifest names one port', () => {
    expect(checksOf('manifest')).toContainEqual({ kind: 'manifest-ports', path: 'mvpfy.yml' });
  });

  it('checks the database step left the stack valid and declared its migrations', () => {
    expect(checksOf('database')).toEqual([
      { kind: 'compose-config', linked: false },
      { kind: 'manifest-ports', path: 'mvpfy.yml' },
      { kind: 'contains', path: 'mvpfy.yml', needles: ['migrations:'] },
    ]);
  });

  it('checks the seed step left the stack valid and the login consistent', () => {
    expect(checksOf('demo-login')).toEqual([
      { kind: 'compose-config', linked: false },
      { kind: 'manifest-ports', path: 'mvpfy.yml' },
      { kind: 'demo-login', manifest: 'mvpfy.yml', env: '.env' },
    ]);
  });

  it('checks the notes exist and the agent files carry the markers', () => {
    expect(checksOf('handover')).toEqual([
      { kind: 'files', paths: ['mvpfy-summary.md', 'mvpfy-run.md'] },
      { kind: 'contains', path: 'AGENTS.md', needles: ['<!-- mvpfy:start', '<!-- mvpfy:end -->'] },
      // `imports`, not a needle: the prompt leaves an existing import alone,
      // and the repository may have written it as @./AGENTS.md.
      { kind: 'imports', path: 'CLAUDE.md', target: 'AGENTS.md' },
    ]);
  });

  it('looks inside .mvpfy/ for a linked folder, and at the root for the agent files', () => {
    expect(checksOf('environment', 'linked')).toEqual([
      { kind: 'files', paths: ['.mvpfy/.env.mvpfy.example', '.mvpfy/.env'] },
      { kind: 'compose-config', linked: true },
    ]);
    expect(checksOf('demo-login', 'linked')).toContainEqual({
      kind: 'demo-login',
      manifest: '.mvpfy/mvpfy.yml',
      env: '.mvpfy/.env',
    });
    // AGENTS.md and CLAUDE.md belong to the repository, not to mvpfy's folder.
    expect(checksOf('handover', 'linked')).toContainEqual({
      kind: 'imports',
      path: 'CLAUDE.md',
      target: 'AGENTS.md',
    });
    expect(units('linked')[0].promptText).toContain('.mvpfy/docker-compose.mvpfy.yml');
  });
});
