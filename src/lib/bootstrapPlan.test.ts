import { describe, expect, it } from 'vitest';
import {
  bareFilePath,
  canMoveTask,
  FlowEvidence,
  parseBootstrapFlow,
  resolveFlow,
  RUNNING_TASK_ID,
  serializeBootstrapFlow,
} from './bootstrapPlan';

const flowJson = (tasks: unknown[]) =>
  JSON.stringify({ version: 1, summary: 'A Rails shop', tasks });

const evidence = (over: Partial<FlowEvidence> = {}): FlowEvidence => ({
  presentFiles: [],
  running: false,
  appHealthy: false,
  accepted: false,
  ...over,
});

describe('parseBootstrapFlow', () => {
  it('parses tasks, defaults lanes and keeps declared files', () => {
    const flow = parseBootstrapFlow(
      flowJson([
        {
          id: 'db',
          title: 'Give your app a database',
          order: 2,
          files: ['docker-compose.mvpfy.yml'],
        },
        { id: 'env', title: 'Fill in the settings', lane: 'doing', order: 1 },
      ])
    );
    expect(flow?.summary).toBe('A Rails shop');
    expect(flow?.tasks.map((t) => t.id)).toEqual(['env', 'db']); // sorted by order
    expect(flow?.tasks[1].lane).toBe('todo');
    expect(flow?.tasks[1].files).toEqual(['docker-compose.mvpfy.yml']);
  });

  it('drops an agent-written imitation of the final card', () => {
    const flow = parseBootstrapFlow(
      flowJson([
        { id: RUNNING_TASK_ID, title: 'App is running', lane: 'done' },
        { id: 'db', title: 'Give your app a database' },
      ])
    );
    expect(flow?.tasks.map((t) => t.id)).toEqual(['db']);
  });

  it('returns null for junk, empty task lists and missing content', () => {
    expect(parseBootstrapFlow(null)).toBeNull();
    expect(parseBootstrapFlow('not json')).toBeNull();
    expect(parseBootstrapFlow(flowJson([]))).toBeNull();
    expect(parseBootstrapFlow(flowJson([{ title: '' }]))).toBeNull();
  });

  it('round-trips through serialize', () => {
    const flow = parseBootstrapFlow(flowJson([{ id: 'db', title: 'Database' }]));
    expect(parseBootstrapFlow(serializeBootstrapFlow(flow!))).toEqual(flow);
  });
});

describe('bareFilePath', () => {
  it('strips the linked-mode config prefix so paths compare equal', () => {
    expect(bareFilePath('.mvpfy/mvpfy.yml')).toBe('mvpfy.yml');
    expect(bareFilePath('./mvpfy.yml')).toBe('mvpfy.yml');
    expect(bareFilePath(' mvpfy/services/api/index.js ')).toBe('mvpfy/services/api/index.js');
  });
});

describe('canMoveTask', () => {
  it('never lets the agent mark anything done or ready to test', () => {
    expect(canMoveTask('doing', 'done', 'agent')).toBe(false);
    expect(canMoveTask('todo', 'testing', 'agent')).toBe(false);
    expect(canMoveTask('doing', 'done', 'agent', true)).toBe(false);
    expect(canMoveTask('todo', 'doing', 'agent')).toBe(true);
    expect(canMoveTask('doing', 'blocked', 'agent')).toBe(true);
  });

  it('lets only evidence close a technical task', () => {
    expect(canMoveTask('doing', 'done', 'system')).toBe(true);
    expect(canMoveTask('doing', 'done', 'human')).toBe(false);
  });

  it('lets only the human close the final card', () => {
    expect(canMoveTask('testing', 'done', 'human', true)).toBe(true);
    expect(canMoveTask('testing', 'done', 'system', true)).toBe(false);
    expect(canMoveTask('doing', 'testing', 'system', true)).toBe(true);
  });
});

describe('resolveFlow', () => {
  const flow = parseBootstrapFlow(
    flowJson([
      { id: 'db', title: 'Database', lane: 'done', files: ['docker-compose.mvpfy.yml'] },
      { id: 'read', title: 'Read your code', lane: 'done' },
    ])
  );

  it('confirms a claim only when every declared file is there', () => {
    const present = resolveFlow(flow, evidence({ presentFiles: ['docker-compose.mvpfy.yml'] }));
    expect(present[0]).toMatchObject({ id: 'db', lane: 'done', verified: true });

    const missing = resolveFlow(flow, evidence());
    expect(missing[0]).toMatchObject({ id: 'db', lane: 'check', verified: false });
  });

  it('matches declared files written under the linked-mode .mvpfy/ folder', () => {
    const resolved = resolveFlow(
      flow,
      evidence({ presentFiles: ['.mvpfy/docker-compose.mvpfy.yml'] })
    );
    expect(resolved[0].lane).toBe('done');
  });

  it('keeps an unconfirmed claim as work-in-progress while the run is going', () => {
    const resolved = resolveFlow(flow, evidence({ running: true }));
    expect(resolved[0].lane).toBe('doing');
  });

  it('accepts an unverifiable claim but never calls it verified', () => {
    const resolved = resolveFlow(flow, evidence());
    expect(resolved[1]).toMatchObject({ id: 'read', lane: 'done', verified: false });
  });

  it('surfaces a task the agent left mid-flight after the run ended', () => {
    const stalled = parseBootstrapFlow(flowJson([{ id: 'x', title: 'Mocks', lane: 'doing' }]));
    expect(resolveFlow(stalled, evidence())[0].lane).toBe('check');
    expect(resolveFlow(stalled, evidence({ running: true }))[0].lane).toBe('doing');
  });

  it('leaves a blocked task alone', () => {
    const blocked = parseBootstrapFlow(
      flowJson([{ id: 'x', title: 'Backend', lane: 'blocked', files: ['a.yml'] }])
    );
    expect(resolveFlow(blocked, evidence({ presentFiles: ['a.yml'] }))[0].lane).toBe('blocked');
  });

  it('appends the final card and gates Done on the human', () => {
    const idle = resolveFlow(flow, evidence()).at(-1)!;
    expect(idle).toMatchObject({ id: RUNNING_TASK_ID, lane: 'todo' });
    expect(resolveFlow(flow, evidence({ running: true })).at(-1)!.lane).toBe('doing');
    // The app being up only ever offers it up for testing.
    expect(resolveFlow(flow, evidence({ appHealthy: true })).at(-1)!.lane).toBe('testing');
    expect(resolveFlow(flow, evidence({ appHealthy: true, accepted: true })).at(-1)!.lane).toBe(
      'done'
    );
  });

  it('has no board at all without a flow file', () => {
    expect(resolveFlow(null, evidence())).toHaveLength(1); // only mvpfy's own card
  });
});
