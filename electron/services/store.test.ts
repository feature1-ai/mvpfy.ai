import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STATE, MvpfyState, Project } from '../../shared/types';
import { isLinkedPath, setLinkedRoots } from '../paths';
import { readState, writeState } from './store';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-store-'));
  file = path.join(dir, 'state.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  setLinkedRoots([]);
});

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    repos: [{ url: 'https://github.com/org/app.git', dir: '/Users/pm/.mvpfy/projects/app' }],
    localPath: '/Users/pm/.mvpfy/projects/app',
    basePort: 4100,
    status: 'stopped',
    lastStoryId: null,
    generatedFiles: ['mvpfy.yml'],
    ...overrides,
  };
}

describe('state store', () => {
  it('round-trips state through the file', () => {
    const state: MvpfyState = {
      tenant: { slug: 'acme', host: 'acme.feature1.ai', tokenKeychainEntry: 'acme-token' },
      projects: [project({ planSlugs: ['dark-mode'], mode: 'managed' })],
      settings: {
        defaultAgent: 'codex',
        codexModel: 'o3',
        claudeModel: 'opus',
        defaultStack: '',
      },
    };
    writeState(state, file);
    expect(readState(file)).toEqual(state);
  });

  it('fills in settings a previous version never wrote', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ tenant: null, projects: [], settings: { defaultAgent: 'codex' } })
    );
    const read = readState(file);
    expect(read.settings.defaultAgent).toBe('codex');
    expect(read.settings.claudeModel).toBe(DEFAULT_STATE.settings.claudeModel);
    expect(read.settings.codexModel).toBe(DEFAULT_STATE.settings.codexModel);
  });

  it('creates intermediate directories when writing', () => {
    const nested = path.join(dir, 'a', 'b', 'state.json');
    writeState(structuredClone(DEFAULT_STATE), nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('falls back to defaults when the file is missing or corrupt', () => {
    expect(readState(path.join(dir, 'nope.json'))).toEqual(DEFAULT_STATE);
    fs.writeFileSync(file, '{not json', 'utf8');
    expect(readState(file)).toEqual(DEFAULT_STATE);
  });

  it('fills missing settings from defaults', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: [] }), 'utf8');
    expect(readState(file)).toEqual(DEFAULT_STATE);
  });

  it('migrates legacy single-repo projects to the repos array', () => {
    const legacy = { ...project(), repos: undefined, repoUrl: 'git@github.com:org/app.git' };
    delete (legacy as Record<string, unknown>).repos;
    fs.writeFileSync(file, JSON.stringify({ projects: [legacy] }), 'utf8');
    const read = readState(file);
    expect(read.projects[0].repos).toEqual([
      { url: 'git@github.com:org/app.git', dir: legacy.localPath },
    ]);
    expect((read.projects[0] as Record<string, unknown>).repoUrl).toBeUndefined();
  });

  it('surfaces a quit mid-bootstrap as an error status', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ projects: [project({ status: 'bootstrapping' })] }),
      'utf8'
    );
    expect(readState(file).projects[0].status).toBe('error');
  });

  it('drops a queued project back to the manual state on restart', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: [project({ status: 'queued' })] }), 'utf8');
    expect(readState(file).projects[0].status).toBe('cloned');
  });

  it('registers linked project roots for the path guards on read and write', () => {
    const linked = project({ id: 'p2', localPath: '/Users/pm/code/shop', mode: 'linked' });
    writeState({ ...structuredClone(DEFAULT_STATE), projects: [linked] }, file);
    expect(isLinkedPath('/Users/pm/code/shop/api')).toBe(true);

    setLinkedRoots([]);
    readState(file);
    expect(isLinkedPath('/Users/pm/code/shop/api')).toBe(true);
    expect(isLinkedPath('/Users/pm/code/other')).toBe(false);
  });
});

describe('the Codex model mvpfy used to choose', () => {
  it('is cleared, because a ChatGPT account refuses it', () => {
    // Every Codex run failed at the first request for anyone signed in that
    // way. Nobody picked it — it was the default — so it does not survive.
    fs.writeFileSync(
      file,
      JSON.stringify({ projects: [], settings: { codexModel: 'gpt-5.3-codex' } }),
      'utf8'
    );
    expect(readState(file).settings.codexModel).toBe('');
  });

  it('leaves a model somebody typed exactly as they typed it', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ projects: [], settings: { codexModel: 'gpt-5-codex' } }),
      'utf8'
    );
    expect(readState(file).settings.codexModel).toBe('gpt-5-codex');
  });

  it('names no model by default, so codex uses its own', () => {
    expect(DEFAULT_STATE.settings.codexModel).toBe('');
  });
});

it('disconnects legacy shared-login connections while preserving projects', () => {
  const projects = [project()];
  fs.writeFileSync(
    file,
    JSON.stringify({
      tenant: { slug: 'watiq', host: 'watiq-mcp.feature1.ai', tokenKeychainEntry: '' },
      projects,
    })
  );
  const state = readState(file);
  expect(state.tenant).toBeNull();
  expect(state.projects).toEqual(projects);
});
