import { Execution, PROTOCOL_VERSION } from './contract';

/**
 * Executions in exactly the shape Feature1's claim endpoint returns them.
 *
 * Written from its schema and service rather than imagined, so a change on
 * that side breaks these loudly instead of being discovered against a live
 * tenant. Shared by the tests and the fake server.
 */

const uuid = (seed: string): string => {
  const hex = seed
    .replace(/[^0-9a-f]/gi, '0')
    .padEnd(32, '0')
    .slice(0, 32)
    .toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export const IDS = {
  tenant: uuid('aaaa1111'),
  project: uuid('bbbb2222'),
  requester: uuid('cccc3333'),
  feature: uuid('dddd4444'),
  story1: uuid('eeee5555'),
  story2: uuid('ffff6666'),
  standaloneStory: uuid('aaab7777'),
  task: uuid('bbbc8888'),
  execFeature: uuid('ccc d9999'),
  execStory: uuid('dddda000'),
  execTask: uuid('eeeeb000'),
  execSame: uuid('ffffc000'),
  repoApi: uuid('1111d000'),
  repoWeb: uuid('2222e000'),
  repoBillingApi: uuid('3333f000'),
  repoOrdersApi: uuid('4444a000'),
  thread: uuid('5555b000'),
  requestKey: uuid('6666c000'),
};

const BASE = {
  protocol_version: PROTOCOL_VERSION,
  tenant_id: IDS.tenant,
  project_id: IDS.project,
  requested_by: IDS.requester,
  assistant_thread_id: IDS.thread,
  request_key: IDS.requestKey,
  state: 'preparing' as const,
  attempt: 1,
  results: {},
  clarifications: [],
  message: null,
  lease_token: 'a'.repeat(64),
  lease_until: '2026-10-22T12:03:00.000Z',
};

const criteria = (...texts: string[]) =>
  texts.map((text, i) => ({ id: `ac-${i + 1}`, description: text }));

/** A feature with two unfinished stories, in generation order. */
export function featureExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    ...BASE,
    id: IDS.execFeature,
    origin_type: 'feature',
    origin_id: IDS.feature,
    owner_type: 'feature',
    owner_id: IDS.feature,
    snapshot: {
      type: 'feature',
      id: IDS.feature,
      code: 'FEA-142',
      title: 'Paged product list',
      description: 'Buyers cannot get past the first fifty products.',
      acceptanceCriteria: criteria('A buyer can reach every product'),
      executionSteps: [],
      taskGoal: null,
      requirements: { summary: 'Paging across the catalogue' },
      dependencies: [],
      stories: [
        {
          type: 'story',
          id: IDS.story1,
          code: 'US-01',
          title: 'Page the product API',
          description: 'The list endpoint returns one page at a time.',
          acceptanceCriteria: criteria(
            'The list endpoint accepts page and pageSize',
            'The response carries a total count'
          ),
          executionSteps: [],
          taskGoal: null,
          dependencies: [],
          digest: 'story-1-digest',
        },
        {
          type: 'story',
          id: IDS.story2,
          code: 'US-02',
          title: 'Page the product list screen',
          description: 'The screen has next and previous.',
          acceptanceCriteria: criteria('The screen has next and previous'),
          executionSteps: [],
          taskGoal: null,
          dependencies: [],
          digest: 'story-2-digest',
        },
      ],
      instructions: '',
      digest: 'feature-digest',
      revision: '2026-10-21T09:00:00.000Z',
    },
    repositories: [
      { id: IDS.repoApi, name: 'api', url: 'https://github.com/acme/api.git', base_branch: 'main' },
      { id: IDS.repoWeb, name: 'web', url: 'https://github.com/acme/web.git', base_branch: 'main' },
    ],
    ...overrides,
  };
}

/** A story that belongs to nothing: it owns its own pull request. */
export function standaloneStoryExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    ...BASE,
    id: IDS.execStory,
    origin_type: 'story',
    origin_id: IDS.standaloneStory,
    owner_type: 'story',
    owner_id: IDS.standaloneStory,
    snapshot: {
      type: 'story',
      id: IDS.standaloneStory,
      code: 'US-09',
      title: 'Export invoices as CSV',
      description: 'Finance re-types invoice data into a spreadsheet every month.',
      // Carried directly: no feature document stands between it and the work.
      acceptanceCriteria: criteria(
        'An Export button appears on the invoices screen',
        'The file opens in a spreadsheet with one row per invoice'
      ),
      executionSteps: [],
      taskGoal: null,
      dependencies: [],
      instructions: '',
      digest: 'standalone-story-digest',
      revision: '2026-10-21T09:00:00.000Z',
    },
    repositories: [
      { id: IDS.repoApi, name: 'api', url: 'https://github.com/acme/api.git', base_branch: 'main' },
    ],
    ...overrides,
  };
}

/** A task with literal steps, owning its own pull request. */
export function standaloneTaskExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    ...BASE,
    id: IDS.execTask,
    origin_type: 'task',
    origin_id: IDS.task,
    owner_type: 'task',
    owner_id: IDS.task,
    snapshot: {
      type: 'task',
      id: IDS.task,
      code: 'TSK-04',
      title: 'Upgrade the date library',
      description: 'The current one is unmaintained.',
      acceptanceCriteria: criteria('The suite passes on the new version'),
      executionSteps: ['Bump the dependency', 'Replace the removed calls', 'Run the suite'],
      taskGoal: 'Remove the unmaintained dependency',
      dependencies: [],
      instructions: 'Keep the change to one commit if you can.',
      digest: 'task-digest',
      revision: '2026-10-21T09:00:00.000Z',
    },
    repositories: [
      { id: IDS.repoApi, name: 'api', url: 'https://github.com/acme/api.git', base_branch: 'main' },
    ],
    ...overrides,
  };
}

/**
 * Two repositories whose names are identical.
 *
 * The case that breaks anything keyed by name: both are called `api`, and
 * only the UUID tells them apart.
 */
export function sameNameExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    ...featureExecution(),
    id: IDS.execSame,
    repositories: [
      {
        id: IDS.repoBillingApi,
        name: 'api',
        url: 'https://github.com/acme/billing-api.git',
        base_branch: 'main',
      },
      {
        id: IDS.repoOrdersApi,
        name: 'api',
        url: 'https://github.com/acme/orders-api.git',
        base_branch: 'main',
      },
    ],
    ...overrides,
  };
}
