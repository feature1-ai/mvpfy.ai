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
      settings: { defaultAgent: 'codex', codexModel: 'gpt-5.3-codex' },
    };
    writeState(state, file);
    expect(readState(file)).toEqual(state);
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
