import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseExecution, unitsOf } from '../shared/runner/validate';
import { commandFrom, configWithoutRunner } from './config';
import { Feature1ConnectionStore } from './feature1Connection';
import { Feature1LoginError } from './feature1Login';
import {
  Feature1ReadError,
  Feature1Reader,
  PulledFeature,
  storyFrom,
  workKindOf,
} from './feature1Reader';
import { Harness, agentChanges, makeHarness, withDiscoverableTests } from './harness';
import {
  ProjectError,
  ProjectStore,
  describeProject,
  projectFrom,
  repositoryFrom,
  uuidFor,
} from './project';
import { NothingToBuildError, PULLED_LEASE_MS, executionFor, snapshotOf } from './pull';

const BASE = 'https://acme.feature1.ai';
const FEATURE_ID = '11111111-1111-4111-8111-111111111111';

/** A Feature1 that answers the four reads a pull makes, and records them. */
function feature1(overrides: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const routes: Record<string, unknown> = {
    '/api/feature-planning?search=FEA-7&pageSize=20&limit=20': {
      success: true,
      features: [
        { id: 'other', code: 'FEA-70' },
        { id: FEATURE_ID, feature_code: 'fea-7' },
      ],
    },
    [`/api/feature-planning/${FEATURE_ID}`]: {
      success: true,
      feature: {
        id: FEATURE_ID,
        code: 'FEA-7',
        title: 'Paged product list',
        description: 'Buyers cannot get past the first fifty products.',
        status: 'approved',
        project_id: '22222222-2222-4222-8222-222222222222',
        analysis_result: JSON.stringify({ prd: { summary: 'Paging across the catalogue' } }),
        updated_at: '2026-11-20T10:00:00.000Z',
      },
    },
    [`/api/feature-planning/${FEATURE_ID}/workflows`]: {
      success: true,
      workflows: [
        { session_id: 'story-a', workflow_status: 'in_progress', title: 'Page the API' },
        { session_id: 'story-b', workflow_status: 'completed', title: 'Already shipped' },
        { sessionId: 'story-c', workflowStatus: 'ready', title: 'Page the screen' },
        {
          sessionId: 'story-d',
          workflowStatus: 'ready_for_testing',
          title: 'Built, awaiting test',
        },
      ],
    },
    '/api/workflows/story-a': {
      success: true,
      workflow: {
        sessionId: 'story-a',
        code: 'US-1',
        stateData: {
          userStory: { title: 'Page the product API', description: 'One page at a time.' },
          acceptanceCriteria: [{ id: 'ac1', text: 'Accepts page and pageSize' }, 'Returns a total'],
          dependencies: ['US-0'],
        },
      },
    },
    '/api/workflows/story-c': {
      success: true,
      workflow: {
        session_id: 'story-c',
        user_story: 'Page the product list screen\nNext and previous.',
        acceptance_criteria: [{ description: 'Has next and previous' }],
      },
    },
    ...overrides,
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = url.pathname + url.search;
    asked.push(`${key} ${(init?.headers as Record<string, string>).Authorization}`);
    const answer = routes[key];
    if (typeof answer === 'number') return new Response('{}', { status: answer });
    if (answer === undefined) return new Response('{"error":"Not found"}', { status: 404 });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  return { asked, reader: new Feature1Reader(fetchImpl) };
}

describe('pulling a feature', () => {
  it('reads the feature, its requirements, and the stories still to build', async () => {
    const { asked, reader } = feature1();
    const feature = await reader.pullFeature(BASE, 'personal', 'FEA-7');
    expect(feature).toMatchObject({
      id: FEATURE_ID,
      code: 'FEA-7',
      title: 'Paged product list',
      projectId: '22222222-2222-4222-8222-222222222222',
      requirements: { summary: 'Paging across the catalogue' },
      finished: [
        { title: 'Already shipped', status: 'completed' },
        { title: 'Built, awaiting test', status: 'ready_for_testing' },
      ],
    });
    expect(feature.stories).toEqual([
      {
        id: 'story-a',
        code: 'US-1',
        title: 'Page the product API',
        description: 'One page at a time.',
        status: 'in_progress',
        acceptanceCriteria: [
          { id: 'ac1', text: 'Accepts page and pageSize' },
          { text: 'Returns a total' },
        ],
        dependencies: ['US-0'],
        revision: null,
      },
      {
        id: 'story-c',
        code: null,
        title: 'Page the screen',
        description: 'Page the product list screen\nNext and previous.',
        status: 'ready',
        acceptanceCriteria: [{ description: 'Has next and previous' }],
        dependencies: [],
        revision: null,
      },
    ]);
    // With the person's token on every request, and no read of a finished story.
    expect(asked.every((line) => line.endsWith(' Bearer personal'))).toBe(true);
    expect(asked.some((line) => line.includes('story-b'))).toBe(false);
    expect(asked.some((line) => line.includes('story-d'))).toBe(false);
  });

  it('takes a feature id as readily as its code, without searching', async () => {
    const { asked, reader } = feature1();
    await reader.pullFeature(BASE, 'personal', FEATURE_ID);
    expect(asked.some((line) => line.includes('search='))).toBe(false);
  });

  it('refuses what Feature1 itself would not queue', async () => {
    const draft = feature1({
      [`/api/feature-planning/${FEATURE_ID}`]: {
        success: true,
        feature: { id: FEATURE_ID, title: 'Half an idea', status: 'draft' },
      },
    });
    await expect(draft.reader.pullFeature(BASE, 't', FEATURE_ID)).rejects.toThrow(/still a draft/);
    const closed = feature1({
      [`/api/feature-planning/${FEATURE_ID}`]: {
        success: true,
        feature: { id: FEATURE_ID, title: 'Shipped', status: 'done' },
      },
    });
    await expect(closed.reader.pullFeature(BASE, 't', FEATURE_ID)).rejects.toThrow(/Reopen it/);
  });

  it('says which thing went wrong', async () => {
    const { reader } = feature1();
    await expect(reader.pullFeature(BASE, 't', 'FEA-404')).rejects.toThrow(Feature1ReadError);
    await expect(reader.pullFeature(BASE, 't', ' ')).rejects.toThrow(/code or id is needed/);
    const rejected = feature1({ [`/api/feature-planning/${FEATURE_ID}`]: 401 });
    await expect(rejected.reader.pullFeature(BASE, 't', FEATURE_ID)).rejects.toThrow(
      Feature1LoginError
    );
    const twice = feature1({
      '/api/feature-planning?search=FEA-7&pageSize=20&limit=20': {
        features: [
          { id: 'a', code: 'FEA-7' },
          { id: 'b', code: 'FEA-7' },
        ],
      },
    });
    await expect(twice.reader.pullFeature(BASE, 't', 'FEA-7')).rejects.toThrow(/More than one/);
  });

  it('reads a story under any of the names Feature1 gives its fields', () => {
    expect(
      storyFrom({
        workflow_id: 'w1',
        status: 'ready',
        state_data: '{"userStoryTitle":"From state"}',
      })
    ).toMatchObject({ id: 'w1', title: 'From state', status: 'ready' });
    expect(storyFrom({ id: 'w2' })).toMatchObject({ id: 'w2', title: 'Untitled story' });
  });
});

describe('the project a runner builds', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-project-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('is repositories by address, each from a branch', () => {
    expect(repositoryFrom('https://github.com/acme/api.git#develop')).toEqual({
      id: uuidFor('https://github.com/acme/api.git'),
      name: 'api',
      url: 'https://github.com/acme/api.git',
      base_branch: 'develop',
    });
    expect(repositoryFrom('https://github.com/acme/web').base_branch).toBe('main');
  });

  it('gives a repository the same id every time, and a different one from its neighbour', () => {
    const id = uuidFor('https://github.com/acme/api.git');
    expect(id).toBe(uuidFor('https://github.com/acme/api.git'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(uuidFor('https://github.com/acme/web.git'));
    expect(uuidFor(FEATURE_ID)).toBe(FEATURE_ID);
  });

  it.each([
    'https://token@github.com/acme/api.git',
    'git@github.com:acme/api.git#main#extra',
    'not a repository',
    'https://github.com/acme/api.git#bad..branch',
    '',
  ])('refuses %j', (argument) => {
    expect(() => repositoryFrom(argument)).toThrow(ProjectError);
  });

  it('refuses none, and the same one twice', () => {
    expect(() => projectFrom([])).toThrow(/at least one/);
    expect(() =>
      projectFrom(['https://github.com/acme/api.git', 'https://github.com/acme/api.git#next'])
    ).toThrow(/twice/);
  });

  it('is kept, and read back through the same checks', () => {
    const store = new ProjectStore(root);
    expect(store.load()).toBeNull();
    const project = projectFrom([
      'https://github.com/acme/api.git',
      'https://github.com/acme/web.git#next',
    ]);
    store.save(project);
    expect(store.load()).toEqual(project);
    expect(describeProject(project)).toContain('web  https://github.com/acme/web.git  (from next)');
    fs.writeFileSync(
      store.file,
      JSON.stringify({ repositories: [{ url: 'https://tok@github.com/a/b.git' }] })
    );
    expect(store.load()).toBeNull();
  });
});

describe('the Feature1 sign-in a runner keeps', () => {
  it.runIf(process.platform !== 'win32')('is written for this user only, and read back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-connection-'));
    const store = new Feature1ConnectionStore(dir);
    expect(store.load()).toBeNull();
    const saved = {
      feature1BaseUrl: BASE,
      token: 'personal',
      tenant: { id: 't1', slug: 'acme' },
      user: { id: 'u1', email: 'pm@acme.test' },
    };
    store.save(saved);
    expect(store.load()).toEqual(saved);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(store.file, '{"token":"only"}');
    expect(store.load()).toBeNull();
  });
});

describe('how the worker is asked to pull', () => {
  it('has a command to say what it builds and one to build a feature', () => {
    expect(commandFrom(['node', 'i', 'project'])).toEqual({ name: 'project', repositories: [] });
    expect(commandFrom(['node', 'i', 'project', 'https://github.com/a/b.git#x'])).toEqual({
      name: 'project',
      repositories: ['https://github.com/a/b.git#x'],
    });
    expect(commandFrom(['node', 'i', 'implement', 'FEA-7'])).toEqual({
      name: 'implement',
      feature: 'FEA-7',
    });
  });

  it.each([
    [['implement']],
    [['implement', 'FEA-7', 'FEA-8']],
    [['implement', '--all']],
    [['project', '--clear']],
  ])('refuses %j', (args) => {
    expect(() => commandFrom(['node', 'i', ...args])).toThrow(/Unrecognised/);
  });

  it('needs no runner credential to pull', () => {
    const config = configWithoutRunner({ MVPFY_WORKER_ROOT: '/w', MVPFY_AGENT: 'codex' });
    expect(config).toMatchObject({ root: '/w', agent: 'codex', fake: false });
  });
});

describe('a pulled feature, as work', () => {
  const project = projectFrom(['https://github.com/acme/api.git']);
  const who = { tenantId: 'tenant-slug-not-a-uuid', userId: 'u1' };
  let pulled: PulledFeature;
  let h: Harness;
  beforeEach(async () => {
    pulled = await feature1().reader.pullFeature(BASE, 'personal', 'FEA-7');
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  it('is an execution the worker accepts exactly as it accepts one from Feature1', async () => {
    // Claimed first, as any execution is: that is what issues its lease.
    const claimed = await h.claim(executionFor(pulled, project, who));
    const parsed = parseExecution(JSON.parse(JSON.stringify(claimed)));
    expect(parsed.origin_id).toBe(FEATURE_ID);
    expect(parsed.repositories).toEqual(project.repositories);
    expect(unitsOf(parsed).map((unit) => unit.title)).toEqual([
      'Page the product API',
      'Page the screen',
    ]);
    expect(parsed.snapshot.requirements).toEqual({ summary: 'Paging across the catalogue' });
  });

  it('carries a digest that changes when the requirements do', () => {
    const before = snapshotOf(pulled).digest;
    expect(snapshotOf(pulled).digest).toBe(before);
    const edited = { ...pulled, stories: [{ ...pulled.stories[0]!, title: 'Something else' }] };
    expect(snapshotOf(edited).digest).not.toBe(before);
  });

  it('is refused when every story is already finished', () => {
    expect(() => executionFor({ ...pulled, stories: [] }, project, who)).toThrow(
      NothingToBuildError
    );
  });

  it('is built by the same engine, story by story, to a pull request', async () => {
    const claimed = await h.claim(executionFor(pulled, project, who));
    const repositoryId = project.repositories[0]!.id;
    withDiscoverableTests(h, claimed, repositoryId);
    agentChanges(h, repositoryId);

    const ending = await h.engine.run(h.checkpoint(claimed), new AbortController().signal);

    expect(ending).toBe('ready_for_testing');
    expect(h.agent.runs).toHaveLength(2);
    expect(h.agent.runs[0]?.prompt).toContain('Page the product API');
    expect(h.agent.runs[0]?.prompt).toContain('Accepts page and pageSize');
    expect(h.transport.stateOf(claimed.id)).toBe('ready_for_testing');
    expect(h.transport.resultsOf(claimed.id)[repositoryId]?.pr_urls).toHaveLength(1);
  });
});

describe('the lease on pulled work', () => {
  const project = projectFrom(['https://github.com/acme/api.git']);
  const who = { tenantId: 't', userId: 'u' };

  async function buildAfterSleeping(leaseMs?: number) {
    const local = makeHarness(leaseMs === undefined ? {} : { leaseMs });
    try {
      const pulled = await feature1().reader.pullFeature(BASE, 'personal', 'FEA-7');
      const claimed = await local.claim(executionFor(pulled, project, who));
      const repositoryId = project.repositories[0]!.id;
      withDiscoverableTests(local, claimed, repositoryId);
      agentChanges(local, repositoryId);
      // The machine sleeps for two hours between the pull and the publish.
      local.setNow('2026-10-22T13:00:00.000Z');
      const ending = await local.engine
        .run(local.checkpoint(claimed), new AbortController().signal)
        .catch((error: Error) => error.message);
      return { ending, pullRequests: local.prs.creates.length };
    } finally {
      local.cleanup();
    }
  }

  it('outlasts a machine that slept, through to the pull request', async () => {
    expect(await buildAfterSleeping(PULLED_LEASE_MS)).toEqual({
      ending: 'ready_for_testing',
      pullRequests: 1,
    });
  });

  it("is what makes the difference: Feature1's three minutes would not have", async () => {
    const { ending, pullRequests } = await buildAfterSleeping();
    expect(String(ending)).toMatch(/lease expired/i);
    expect(pullRequests).toBe(0);
  });
});

describe('pulling one story, bug or task', () => {
  const project = projectFrom(['https://github.com/acme/api.git']);
  const who = { tenantId: 't', userId: 'u' };

  it('reads what the code names', () => {
    expect(workKindOf('THA-F-11')).toBe('feature');
    expect(workKindOf('tha-us-52')).toBe('story');
    expect(workKindOf('THA-BUG-3')).toBe('bug');
    expect(workKindOf('THA-T-8')).toBe('task');
    expect(workKindOf('THA-SPK-2')).toBe('spike');
    expect(workKindOf(FEATURE_ID)).toBeNull();
  });

  it('builds a story on its own, as the story it is', async () => {
    const { reader } = feature1({
      '/api/workflows?search=THA-US-52&includeGenerated=true&limit=20': {
        workflows: [
          { session_id: 'story-x', code: 'THA-US-520', workflow_status: 'ready', title: 'Other' },
          {
            session_id: 'story-52',
            code: 'THA-US-52',
            workflow_status: 'ready',
            title: 'Show the cap',
            project_id: '22222222-2222-4222-8222-222222222222',
          },
        ],
      },
      '/api/workflows/story-52': {
        workflow: {
          sessionId: 'story-52',
          code: 'THA-US-52',
          stateData: {
            userStory: { title: 'Show the pilot cap', description: 'On the queue.' },
            acceptanceCriteria: ['The cap is shown'],
          },
        },
      },
    });
    const story = await reader.pullWork(BASE, 'tok', 'THA-US-52');
    expect(story).toMatchObject({ kind: 'story', code: 'THA-US-52', title: 'Show the pilot cap' });
    const execution = executionFor(story, project, who);
    expect(execution.origin_type).toBe('story');
    expect(execution.snapshot).toMatchObject({ type: 'story', code: 'THA-US-52' });
    expect(execution.snapshot.stories).toBeUndefined();
    expect(unitsOf(execution)).toHaveLength(1);
    expect(unitsOf(execution)[0]?.acceptanceCriteria).toEqual([{ text: 'The cap is shown' }]);
  });

  it('refuses a story that is already built, and a code Feature1 does not have', async () => {
    const { reader } = feature1({
      '/api/workflows?search=THA-BUG-3&includeGenerated=true&limit=20': {
        workflows: [{ session_id: 'b3', code: 'THA-BUG-3', workflow_status: 'ready_for_testing' }],
      },
      '/api/workflows?search=THA-US-9&includeGenerated=true&limit=20': { workflows: [] },
    });
    await expect(reader.pullWork(BASE, 'tok', 'THA-BUG-3')).rejects.toThrow(
      /nothing left to build/
    );
    await expect(reader.pullWork(BASE, 'tok', 'THA-US-9')).rejects.toThrow(
      /no story with the code/
    );
    await expect(reader.pullWork(BASE, 'tok', 'THA-SPK-1')).rejects.toThrow(/spike/);
  });

  it('builds a task on its own, as a task', async () => {
    const { reader } = feature1({
      '/api/tasks?search=THA-T-8&limit=20': {
        tasks: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            code: 'THA-T-8',
            title: 'Rename the menu',
            description: 'Call it Safety.',
            status: 'todo',
          },
        ],
      },
    });
    const task = await reader.pullWork(BASE, 'tok', 'THA-T-8');
    const execution = executionFor(task, project, who);
    expect(execution.snapshot).toMatchObject({ type: 'task', title: 'Rename the menu' });
    expect(execution.owner_type).toBe('task');
  });
});
