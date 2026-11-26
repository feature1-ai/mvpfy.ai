import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Feature1McpReader, MCP_ACCESS_FILE, sectionOf, storiesIn } from './feature1Mcp';
import { Feature1ConnectionStore, readerFor } from './feature1Connection';
import { Feature1Reader } from './feature1Reader';
import { feature1Step } from './setup';

const MCP = 'https://acme-mcp.feature1.ai/mcp';
const FEATURE = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222222';
const S2 = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';

// What Feature1's get_feature writes (mcp-server/feature-management.js).
const FEATURE_PAGE = `# Feature: Pause everything

**Code**: ACME-F-7
**ID**: ${FEATURE}
**Status**: approved
**Priority**: high

## Description
Let an admin pause all sends.

## Decomposition
Not decomposed yet

## User Flow
- Admin opens settings

## PRD (Product Requirements Document)
**Problem**
Sends cannot be stopped.

**Goals**
- Stop in one click

## User Stories (2)
### 1. Pause button
**Code**: ACME-US-1
**Session ID**: ${S1}
**Status**: in_progress
**Complexity**: 3 pts, 2 ACs
**Description**: A button

### 2. Audit entry
**Code**: ACME-US-2
**Session ID**: ${S2}
**Status**: ready_for_testing
**Complexity**: -, 1 ACs
`;

type Call = { name: string; args: Record<string, unknown> };

function fakeMcp(calls: Call[], tools: Record<string, (args: Record<string, unknown>) => unknown>) {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer f1mcp_access');
    if (href.endsWith('/login/status')) {
      return new Response(
        JSON.stringify({
          authenticated: true,
          tenant: { id: 't-1', slug: 'acme' },
          user: { id: 'u-1', email: 'pm@acme.test' },
        })
      );
    }
    expect(href).toBe(MCP);
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      params: { name: string; arguments: Record<string, unknown> };
    };
    calls.push({ name: body.params.name, args: body.params.arguments });
    const tool = tools[body.params.name];
    if (!tool) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32603, message: 'Unknown tool' },
        })
      );
    }
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: tool(body.params.arguments) })
    );
  }) as typeof fetch;
}

const story = (id: string, code: string, status: string) => ({
  content: [{ type: 'text', text: `# User Story: ${code}` }],
  structuredContent: {
    session_id: id,
    code,
    title: `Story ${code}`,
    description: 'As an admin…',
    status,
    project_id: 'p-1',
    acceptance_criteria: [{ text: 'It pauses' }, 'It says so'],
  },
});

describe("reading the text Feature1's MCP server writes", () => {
  it("finds a feature's sections and stories", () => {
    expect(sectionOf(FEATURE_PAGE, 'PRD')).toBe(
      '**Problem**\nSends cannot be stopped.\n\n**Goals**\n- Stop in one click'
    );
    expect(storiesIn(FEATURE_PAGE)).toEqual([
      { id: S1, code: 'ACME-US-1', title: 'Pause button', status: 'in_progress' },
      { id: S2, code: 'ACME-US-2', title: 'Audit entry', status: 'ready_for_testing' },
    ]);
  });
});

describe('pulling work through MCP', () => {
  it('pulls a feature: its stories still to build, whole, and the PRD as Feature1 writes it', async () => {
    const calls: Call[] = [];
    const reader = new Feature1McpReader(
      fakeMcp(calls, {
        list_features: () => ({
          content: [{ type: 'text', text: '…' }],
          structuredContent: {
            features: [
              {
                id: FEATURE,
                code: 'ACME-F-7',
                title: 'Pause everything',
                status: 'approved',
                description: 'Let an admin pause all sends.',
                project_id: 'p-1',
                updated_at: '2026-11-26T08:00:00Z',
              },
              { id: 'other', code: 'ACME-F-70', title: 'Other', status: 'approved' },
            ],
          },
        }),
        get_feature: () => ({ content: [{ type: 'text', text: FEATURE_PAGE }] }),
        get_user_story: (args) => story(String(args.session_id), 'ACME-US-1', 'in_progress'),
      })
    );
    const pulled = await reader.pullWork(MCP, 'f1mcp_access', 'acme-f-7');
    expect(pulled).toMatchObject({
      id: FEATURE,
      code: 'ACME-F-7',
      title: 'Pause everything',
      status: 'approved',
      projectId: 'p-1',
      revision: '2026-11-26T08:00:00Z',
      finished: [{ title: 'Audit entry', status: 'ready_for_testing' }],
    });
    expect(String(pulled.requirements)).toContain('Sends cannot be stopped.');
    expect(pulled.stories).toHaveLength(1);
    expect(pulled.stories[0]).toMatchObject({
      id: S1,
      code: 'ACME-US-1',
      acceptanceCriteria: [{ text: 'It pauses' }, { text: 'It says so' }],
    });
    expect(pulled.stories[0]?.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(calls.map((c) => c.name)).toEqual(['list_features', 'get_feature', 'get_user_story']);
    expect(calls[2]?.args).toEqual({ session_id: S1 });
  });

  it('refuses a draft feature, and a finished story', async () => {
    const draft = new Feature1McpReader(
      fakeMcp([], {
        list_features: () => ({
          content: [],
          structuredContent: {
            features: [{ id: FEATURE, code: 'ACME-F-7', title: 'Pause', status: 'draft' }],
          },
        }),
        get_feature: () => ({ content: [{ type: 'text', text: FEATURE_PAGE }] }),
      })
    );
    await expect(draft.pullWork(MCP, 'f1mcp_access', 'ACME-F-7')).rejects.toThrow(/still a draft/);
    const done = new Feature1McpReader(
      fakeMcp([], { get_user_story: () => story(S2, 'ACME-US-2', 'ready_for_testing') })
    );
    await expect(done.pullWork(MCP, 'f1mcp_access', 'ACME-US-2')).rejects.toThrow(
      /nothing left to build/
    );
  });

  it('pulls a story and a task on their own', async () => {
    const calls: Call[] = [];
    const reader = new Feature1McpReader(
      fakeMcp(calls, {
        get_user_story: () => story(S1, 'ACME-BUG-3', 'open'),
        list_tasks: () => ({
          content: [],
          structuredContent: {
            tasks: [
              { id: TASK, code: 'ACME-T-8', status: 'todo' },
              { id: 'x', code: 'ACME-T-80' },
            ],
          },
        }),
        get_task: () => ({
          content: [{ type: 'text', text: '…' }],
          structuredContent: {
            task_id: TASK,
            code: 'ACME-T-8',
            title: 'Rotate keys',
            description: 'Do it',
            task_goal: 'Safer',
            status: 'todo',
            project_id: 'p-1',
          },
        }),
      })
    );
    const bug = await reader.pullWork(MCP, 'f1mcp_access', 'ACME-BUG-3');
    expect(bug).toMatchObject({ kind: 'bug', id: S1, projectId: 'p-1', stories: [{ id: S1 }] });
    const task = await reader.pullWork(MCP, 'f1mcp_access', 'ACME-T-8');
    expect(task).toMatchObject({
      kind: 'task',
      id: TASK,
      title: 'Rotate keys',
      description: 'Do it\n\nGoal: Safer',
    });
    expect(calls.find((c) => c.name === 'list_tasks')?.args).toEqual({
      search: 'ACME-T-8',
      standalone_only: false,
      limit: 20,
    });
  });

  it('treats a failure a tool only reports in its text as a failure', async () => {
    const reader = new Feature1McpReader(
      fakeMcp([], {
        list_features: () => ({
          content: [],
          structuredContent: { features: [{ id: FEATURE, code: 'ACME-F-7', status: 'approved' }] },
        }),
        get_feature: () => ({
          content: [{ type: 'text', text: '❌ Error fetching feature: 500' }],
        }),
      })
    );
    await expect(reader.pullWork(MCP, 'f1mcp_access', 'ACME-F-7')).rejects.toThrow(
      'Error fetching feature: 500'
    );
  });

  it('notes a change on a story at its current revision, and nowhere for a feature', async () => {
    const calls: Call[] = [];
    const reader = new Feature1McpReader(
      fakeMcp(calls, {
        get_story_change_context: () => ({
          content: [],
          structuredContent: { revision: 'a'.repeat(64) },
        }),
        add_user_story_comment: () => ({
          content: [{ type: 'text', text: '{}' }],
          structuredContent: {},
        }),
      })
    );
    expect(await reader.note(MCP, 'f1mcp_access', 'ACME-US-1', 'x'.repeat(6000))).toBe(true);
    const comment = calls.find((c) => c.name === 'add_user_story_comment');
    expect(comment?.args.expected_revision).toBe('a'.repeat(64));
    expect(String(comment?.args.reason)).toHaveLength(5000);
    expect(await reader.note(MCP, 'f1mcp_access', 'ACME-F-7', 'x')).toBe(false);
  });
});

describe('a runner connected from the web app', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-mcp-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("needs no token at setup, and reads the host's latest access each time", async () => {
    const access = (token: string) =>
      fs.writeFileSync(
        path.join(dir, MCP_ACCESS_FILE),
        JSON.stringify({ mcpUrl: MCP, accessToken: token, expiresAt: '2026-11-26T09:00:00Z' })
      );
    access('f1mcp_access');
    const connections = new Feature1ConnectionStore(dir);
    const said: string[] = [];
    const step = feature1Step({
      io: {
        say: (t) => said.push(t),
        ask: async () => {
          throw new Error('asked for a token');
        },
      },
      login: {
        verify: async () => {
          throw new Error('used the REST sign-in');
        },
        mintRunner: async () => {
          throw new Error('minted');
        },
      },
      store: { load: () => null, save: () => {} },
      connections,
      name: 'runner',
      mcp: {
        access: () => ({ mcpUrl: MCP, accessToken: 'f1mcp_access' }),
        whoami: async () => ({
          tenant: { id: 't-1', slug: 'acme' },
          user: { id: 'u-1', email: 'pm@acme.test' },
        }),
      },
    });
    expect(await step.done()).toBe(false);
    await step.perform();
    expect(await step.done()).toBe(true);
    expect(said.join('\n')).toContain('through Feature1');
    // The access is the host's; what is kept here has none.
    expect(fs.readFileSync(connections.file, 'utf8')).not.toContain('f1mcp_');

    access('f1mcp_renewed');
    const loaded = connections.load();
    expect(loaded).toMatchObject({
      via: 'mcp',
      feature1BaseUrl: MCP,
      token: 'f1mcp_renewed',
      tenant: { id: 't-1' },
    });
    expect(readerFor(loaded!)).toBeInstanceOf(Feature1McpReader);
    expect(readerFor({ ...loaded!, via: undefined })).toBeInstanceOf(Feature1Reader);

    // Without the host's access there is no connection to use.
    fs.rmSync(path.join(dir, MCP_ACCESS_FILE));
    expect(connections.load()).toBeNull();
  });
});
