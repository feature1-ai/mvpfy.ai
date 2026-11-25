import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { featureExecution } from '../shared/runner/fixtures';
import {
  applyLinkSettings,
  parseLinkSettings,
  readLinkSettings,
  requestedLinkSettings,
} from './linkSettings';
import { buildPrompt } from './prompt';

describe('settings a test link needs', () => {
  it('reads KEY=value lines, last one wins, and skips anything else', () => {
    expect(
      parseLinkSettings(
        '# flags\nNUXT_VISUAL_STORIES_ENABLED=false\nNUXT_VISUAL_STORIES_ENABLED=true\nlower=1\n=x\nNO_EQUALS\n'
      )
    ).toEqual([{ key: 'NUXT_VISUAL_STORIES_ENABLED', value: 'true' }]);
  });

  it('never carries a secret', () => {
    expect(parseLinkSettings('API_KEY=abc\nSESSION_SECRET=x\nGH=ghp_abcdef\nFLAG=on')).toEqual([
      { key: 'FLAG', value: 'on' },
    ]);
  });

  it("finds what the build asked for in its output, even inside the agent's JSON", () => {
    const tail =
      '{"type":"result","result":"Done.\\nTEST_LINK_SETTING NUXT_VISUAL_STORIES_ENABLED=true\\nTEST_LINK_SETTING PILOT_CAP=5"}';
    expect(requestedLinkSettings(tail)).toEqual([
      { key: 'NUXT_VISUAL_STORIES_ENABLED', value: 'true' },
      { key: 'PILOT_CAP', value: '5' },
    ]);
    expect(requestedLinkSettings('no settings needed')).toEqual([]);
  });

  it('are laid over the recipe env file, replacing what it set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-link-'));
    const env = path.join(dir, '.env');
    fs.writeFileSync(env, 'A=1\nNUXT_VISUAL_STORIES_ENABLED=false\n');
    fs.writeFileSync(
      path.join(dir, 'link-settings.env'),
      'NUXT_VISUAL_STORIES_ENABLED=true\nNEW_FLAG=on\n'
    );
    applyLinkSettings(env, readLinkSettings(dir));
    const text = fs.readFileSync(env, 'utf8');
    expect(text).toContain('A=1\nNUXT_VISUAL_STORIES_ENABLED=true\nNEW_FLAG=on\n');
    expect(text).not.toContain('=false');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('are what every build is told to name rather than change', () => {
    const execution = featureExecution();
    const prompt = buildPrompt({
      execution,
      worktrees: {},
      questionsFile: '/q.md',
      unit: execution.snapshot.stories![0]!,
    });
    expect(prompt).toContain('TEST_LINK_SETTING KEY=value');
    expect(prompt).toContain('do not change that default');
  });
});
