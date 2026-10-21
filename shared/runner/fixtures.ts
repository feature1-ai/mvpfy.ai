import { Assignment, CONTRACT_VERSION } from './contract';

/**
 * Canned assignments, shared by the tests and the fake Feature1 server.
 *
 * These are the shapes the worker claims to handle, written down once so a
 * change to the contract breaks them loudly instead of being discovered at
 * the other end of an integration.
 */

const BASE = {
  contractVersion: CONTRACT_VERSION,
  tenantId: 'acme',
  projectId: 'proj-1',
  stage: 'implement' as const,
  leaseExpiresAt: '2026-10-21T12:00:00.000Z',
};

/** A feature with two selected stories, the second depending on the first. */
export function featureAssignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    ...BASE,
    assignmentId: 'asg-feature-1',
    executionId: 'exec-feature-1',
    attemptId: 'attempt-1',
    attemptToken: 'token-1',
    artifact: { type: 'feature', id: 'fea-142', code: 'FEA-142', title: 'Paged product list' },
    prOwner: { type: 'feature', id: 'fea-142' },
    requirements: {
      revision: 'rev-3',
      title: 'Paged product list',
      description: 'Buyers cannot get past the first fifty products.',
      acceptanceCriteria: [{ id: 'ac-f1', text: 'A buyer can reach every product' }],
      items: [
        {
          id: 'us-1',
          type: 'story',
          code: 'US-01',
          title: 'Page the product API',
          acceptanceCriteria: [
            { id: 'ac-1', text: 'The list endpoint accepts page and pageSize' },
            { id: 'ac-2', text: 'The response carries a total count' },
          ],
        },
        {
          id: 'us-2',
          type: 'story',
          code: 'US-02',
          title: 'Page the product list screen',
          acceptanceCriteria: [{ id: 'ac-3', text: 'The screen has next and previous' }],
          dependsOn: ['us-1'],
        },
      ],
    },
    repositories: [
      {
        repositoryId: 'repo-api',
        name: 'api',
        cloneUrl: 'https://github.com/acme/api.git',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
      },
      {
        repositoryId: 'repo-web',
        name: 'web',
        cloneUrl: 'https://github.com/acme/web.git',
        baseBranch: 'main',
        baseCommit: 'b'.repeat(40),
      },
    ],
    verification: {
      steps: [
        {
          id: 'v-api-test',
          kind: 'test',
          name: 'API tests',
          command: 'npm test',
          repositoryId: 'repo-api',
        },
        {
          id: 'v-web-test',
          kind: 'test',
          name: 'Web tests',
          command: 'npm test',
          repositoryId: 'repo-web',
        },
      ],
    },
    ...overrides,
  };
}

/** A story that belongs to nothing: it owns its own pull request. */
export function standaloneStoryAssignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    ...BASE,
    assignmentId: 'asg-story-1',
    executionId: 'exec-story-1',
    attemptId: 'attempt-1',
    attemptToken: 'token-1',
    artifact: { type: 'story', id: 'sto-9', code: 'US-09', title: 'Export invoices as CSV' },
    prOwner: { type: 'story', id: 'sto-9' },
    requirements: {
      revision: 'rev-1',
      title: 'Export invoices as CSV',
      description: 'Finance re-types invoice data into a spreadsheet every month.',
      // Carried directly. A standalone story must not be made to write a PRD.
      acceptanceCriteria: [
        { id: 'ac-1', text: 'An Export button appears on the invoices screen' },
        { id: 'ac-2', text: 'The file opens in a spreadsheet with one row per invoice' },
      ],
      items: [],
    },
    repositories: [
      {
        repositoryId: 'repo-api',
        name: 'api',
        cloneUrl: 'https://github.com/acme/api.git',
        baseBranch: 'main',
        baseCommit: 'c'.repeat(40),
      },
    ],
    verification: { steps: [], allowDiscovery: true },
    ...overrides,
  };
}

/** A task with literal steps, owning its own pull request. */
export function standaloneTaskAssignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    ...BASE,
    assignmentId: 'asg-task-1',
    executionId: 'exec-task-1',
    attemptId: 'attempt-1',
    attemptToken: 'token-1',
    artifact: { type: 'task', id: 'tsk-4', code: 'TSK-04', title: 'Upgrade the date library' },
    prOwner: { type: 'task', id: 'tsk-4' },
    requirements: {
      revision: 'rev-1',
      title: 'Upgrade the date library',
      acceptanceCriteria: [{ id: 'ac-1', text: 'The suite passes on the new version' }],
      items: [
        {
          id: 'tsk-4',
          type: 'task',
          title: 'Upgrade the date library',
          acceptanceCriteria: [{ id: 'ac-1', text: 'The suite passes on the new version' }],
          executionSteps: ['Bump the dependency', 'Replace the removed calls', 'Run the suite'],
        },
      ],
    },
    repositories: [
      {
        repositoryId: 'repo-api',
        name: 'api',
        cloneUrl: 'https://github.com/acme/api.git',
        baseBranch: 'main',
        baseCommit: 'd'.repeat(40),
      },
    ],
    verification: {
      steps: [
        {
          id: 'v-test',
          kind: 'test',
          name: 'Tests',
          command: 'npm test',
          repositoryId: 'repo-api',
        },
      ],
    },
    ...overrides,
  };
}

/**
 * Two repositories whose basenames are identical.
 *
 * The case that breaks anything keyed by folder name: both are called `api`,
 * and only the repository id tells them apart.
 */
export function sameBasenameAssignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    ...featureAssignment(),
    assignmentId: 'asg-same-1',
    executionId: 'exec-same-1',
    repositories: [
      {
        repositoryId: 'repo-billing-api',
        name: 'api',
        cloneUrl: 'https://github.com/acme/billing/api.git',
        baseBranch: 'main',
        baseCommit: 'e'.repeat(40),
      },
      {
        repositoryId: 'repo-orders-api',
        name: 'api',
        cloneUrl: 'https://github.com/acme/orders/api.git',
        baseBranch: 'main',
        baseCommit: 'f'.repeat(40),
      },
    ],
    verification: { steps: [] },
    ...overrides,
  };
}
