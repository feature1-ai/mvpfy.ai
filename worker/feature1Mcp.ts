import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AcceptanceCriterion } from '../shared/runner/contract';
import { UUID } from '../shared/runner/validate';
import { Feature1LoginError } from './feature1Login';
import {
  Feature1ReadError,
  PulledFeature,
  PulledStory,
  STORY_FINISHED,
  FEATURE_CLOSED,
  WorkKind,
  workKindOf,
} from './feature1Reader';

/**
 * Feature1 through its MCP server, for a runner connected from the web app.
 *
 * The hosted runner is given no personal token. A member of the workspace
 * connects it in the browser, and the host gives it an access token for the
 * workspace's MCP server, good for an hour and renewed before it runs out, in
 * `feature1-mcp.json` on its secrets volume. Everything it reads and every
 * note it leaves goes through the same tools a person's own coding agent
 * uses, as whoever connected it.
 *
 * Three things the REST reader has, these tools give only as prose or not at
 * all: a feature's requirements (its PRD, as the text `get_feature` writes),
 * its list of stories (read from that text, each then fetched whole), and
 * notes on a feature (none: the pull request has the note instead). A story's
 * revision is a digest of what it says, since no tool gives its update time.
 */

export interface McpAccess {
  mcpUrl: string;
  accessToken: string;
  expiresAt: string;
}

export const MCP_ACCESS_FILE = 'feature1-mcp.json';

/** The access the host left, read afresh each time: it is replaced every hour. */
export function loadMcpAccess(dir: string): McpAccess | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MCP_ACCESS_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    if (typeof raw.mcpUrl !== 'string' || !/^https?:\/\/[^\s]+\/mcp$/.test(raw.mcpUrl)) return null;
    if (typeof raw.accessToken !== 'string' || !raw.accessToken) return null;
    return {
      mcpUrl: raw.mcpUrl,
      accessToken: raw.accessToken,
      expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : '',
    };
  } catch {
    return null;
  }
}

type Row = Record<string, unknown>;
const row = (value: unknown): Row => (value && typeof value === 'object' ? (value as Row) : {});
const text = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
};

export interface ToolResult {
  text: string;
  structured: Row | null;
}

function criteria(value: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): AcceptanceCriterion | null => {
      if (typeof item === 'string') return item.trim() ? { text: item } : null;
      return item && typeof item === 'object' ? (item as AcceptanceCriterion) : null;
    })
    .filter((item): item is AcceptanceCriterion => item !== null);
}

const digest = (value: unknown) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** One section of the text `get_feature` writes, by its heading. */
export function sectionOf(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** The stories `get_feature` lists: each one's session id, code and status. */
export function storiesIn(
  markdown: string
): Array<{ id: string; code: string | null; title: string; status: string }> {
  const section = sectionOf(markdown, 'User Stories');
  return section
    .split(/\n(?=### \d+\. )/)
    .map((block) => {
      const title = block.match(/^### \d+\. (.*)$/m)?.[1]?.trim() ?? '';
      const id = block.match(/^\*\*Session ID\*\*: (\S+)/m)?.[1] ?? '';
      const code = block.match(/^\*\*Code\*\*: (\S+)/m)?.[1] ?? null;
      const status = block.match(/^\*\*Status\*\*: (\S+)/m)?.[1] ?? '';
      return { id: UUID.test(id) ? id : '', code, title, status };
    })
    .filter((s) => s.id);
}

export class Feature1Mcp {
  private next = 1;

  constructor(
    private readonly mcpUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async post(body: Row): Promise<Row> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.mcpUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new Feature1ReadError(`Feature1 could not be reached: ${(error as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Feature1LoginError(
        'Feature1 no longer accepts the runner’s connection. Connect it again from the web app.'
      );
    }
    const raw = await response.text();
    const payload = raw.trim().startsWith('{') ? raw : (raw.match(/^data: (.*)$/m)?.[1] ?? '');
    let parsed: Row;
    try {
      parsed = row(JSON.parse(payload));
    } catch {
      throw new Feature1ReadError(
        `Feature1 answered something unexpected (HTTP ${response.status})`
      );
    }
    const error = row(parsed.error);
    if (parsed.error) {
      if (error.code === -32001) {
        throw new Feature1LoginError(
          'Feature1 no longer accepts the runner’s connection. Connect it again from the web app.'
        );
      }
      throw new Feature1ReadError(`Feature1: ${text(error.message) || 'an error'}`);
    }
    return row(parsed.result);
  }

  /** Call one tool. A tool that failed, said so or not, is an error here. */
  async call(name: string, args: Row): Promise<ToolResult> {
    const result = await this.post({
      jsonrpc: '2.0',
      id: this.next++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const content = Array.isArray(result.content) ? result.content.map(row) : [];
    const body = content
      .filter((c) => c.type === 'text')
      .map((c) => text(c.text))
      .join('\n');
    // Some tools report a failure only in their text.
    if (result.isError === true || body.trimStart().startsWith('❌')) {
      throw new Feature1ReadError(body.replace(/^❌\s*/, '').trim() || `Feature1's ${name} failed`);
    }
    const structured = result.structuredContent ?? result.structured_content;
    return { text: body, structured: structured ? row(structured) : null };
  }

  /** Who the connection is, from the MCP host's own status page. */
  async whoami(): Promise<{
    tenant: { id: string; slug: string };
    user: { id: string; email?: string };
  }> {
    const url = new URL('/login/status', this.mcpUrl).toString();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Feature1LoginError(`Feature1 could not be reached: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new Feature1LoginError(
        response.status === 401 || response.status === 403
          ? 'Feature1 does not accept the runner’s connection. Connect it again from the web app.'
          : `Feature1 answered ${response.status} when asked who the runner is`
      );
    }
    const body = row(await response.json().catch(() => ({})));
    const tenant = row(body.tenant);
    const user = row(body.user);
    if (!text(tenant.id) || !text(user.id)) {
      throw new Feature1LoginError('Feature1 did not say which workspace and person this is');
    }
    return {
      tenant: { id: text(tenant.id), slug: text(tenant.slug) },
      user: { id: text(user.id), ...(text(user.email) ? { email: text(user.email) } : {}) },
    };
  }
}

/** The same reads and notes as Feature1Reader, through the MCP server. */
export class Feature1McpReader {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private story(found: Row, fallbackId: string): PulledStory {
    return {
      id: text(found.session_id) || fallbackId,
      code: text(found.code) || null,
      title: text(found.title) || 'Untitled story',
      description: text(found.description),
      status: text(found.status),
      acceptanceCriteria: criteria(found.acceptance_criteria),
      dependencies: [],
      revision: digest([found.title, found.description, found.status, found.acceptance_criteria]),
    };
  }

  async pullWork(mcpUrl: string, token: string, reference: string): Promise<PulledFeature> {
    const ref = reference.trim();
    if (!ref) throw new Feature1ReadError('A feature code or id is needed');
    const kind = workKindOf(ref);
    if (kind === 'spike') {
      throw new Feature1ReadError(`${ref} is a spike: research to do, not something to build.`);
    }
    const mcp = new Feature1Mcp(mcpUrl, token, this.fetchImpl);
    if (kind === 'story' || kind === 'bug') return this.pullStory(mcp, ref, kind);
    if (kind === 'task') return this.pullTask(mcp, ref);
    return this.pullFeature(mcp, ref);
  }

  private async pullFeature(mcp: Feature1Mcp, ref: string): Promise<PulledFeature> {
    // The list has what the feature's own page gives only as text.
    const listed = await mcp.call('list_features', { search_term: ref, limit: 20 });
    const rows = (Array.isArray(listed.structured?.features) ? listed.structured.features : []).map(
      row
    );
    const matches = UUID.test(ref)
      ? rows.filter((f) => text(f.id) === ref)
      : rows.filter((f) => text(f.code).toLowerCase() === ref.toLowerCase());
    if (matches.length > 1) {
      throw new Feature1ReadError(`More than one feature has the code ${ref}. Use its id instead.`);
    }
    const summary = matches[0] ?? {};
    const id = text(summary.id) || (UUID.test(ref) ? ref : '');
    if (!id) throw new Feature1ReadError(`Feature1 has no feature with the code ${ref}`);

    const page = await mcp.call('get_feature', { feature_id: id });
    const title =
      text(summary.title) ||
      page.text.match(/^# Feature: (.*)$/m)?.[1]?.trim() ||
      'Untitled feature';
    const status = text(summary.status) || page.text.match(/^\*\*Status\*\*: (\S+)/m)?.[1] || '';
    if (status === 'draft') {
      throw new Feature1ReadError(
        `"${title}" is still a draft. Approve its scope in Feature1 first.`
      );
    }
    if (FEATURE_CLOSED.includes(status)) {
      throw new Feature1ReadError(`"${title}" is ${status}. Reopen it in Feature1 to build it.`);
    }

    const stories: PulledStory[] = [];
    const finished: PulledFeature['finished'] = [];
    for (const listedStory of storiesIn(page.text)) {
      if (STORY_FINISHED.includes(listedStory.status)) {
        finished.push({ title: listedStory.title, status: listedStory.status });
        continue;
      }
      const detail = await mcp.call('get_user_story', { session_id: listedStory.id });
      const story = this.story(detail.structured ?? {}, listedStory.id);
      if (!story.code && listedStory.code) story.code = listedStory.code;
      stories.push(story);
    }

    const prd = sectionOf(page.text, 'PRD');
    return {
      id,
      code: text(summary.code) || page.text.match(/^\*\*Code\*\*: (\S+)/m)?.[1] || null,
      title,
      description: text(summary.description) || sectionOf(page.text, 'Description'),
      status,
      projectId: text(summary.project_id) || null,
      // As Feature1's MCP server writes it: prose, not the PRD's own fields.
      requirements: prd && !/^not (generated|available)/i.test(prd) ? prd : null,
      revision: text(summary.updated_at) || digest(page.text),
      stories,
      finished,
    };
  }

  private async pullStory(
    mcp: Feature1Mcp,
    code: string,
    kind: 'story' | 'bug'
  ): Promise<PulledFeature> {
    let found: ToolResult;
    try {
      found = await mcp.call('get_user_story', { session_id: code });
    } catch (error) {
      if (error instanceof Feature1LoginError) throw error;
      throw new Feature1ReadError(
        `Feature1 has no ${kind} with the code ${code}: ${(error as Error).message}`
      );
    }
    const detail = found.structured ?? {};
    const story = this.story(detail, '');
    if (!story.id) throw new Feature1ReadError(`Feature1 has no ${kind} with the code ${code}`);
    if (STORY_FINISHED.includes(story.status)) {
      throw new Feature1ReadError(
        `"${story.title}" is ${story.status.replace(/_/g, ' ')}. There is nothing left to build.`
      );
    }
    return {
      kind,
      id: story.id,
      code: story.code ?? code,
      title: story.title,
      description: story.description,
      status: story.status,
      projectId: text(detail.project_id) || null,
      requirements: null,
      revision: story.revision,
      stories: [story],
      finished: [],
    };
  }

  private async pullTask(mcp: Feature1Mcp, code: string): Promise<PulledFeature> {
    // Every task, not only those outside a story: a story's task can be built too.
    const listed = await mcp.call('list_tasks', {
      search: code,
      standalone_only: false,
      limit: 20,
    });
    const rows = (Array.isArray(listed.structured?.tasks) ? listed.structured.tasks : []).map(row);
    const matches = rows.filter((t) => text(t.code).toLowerCase() === code.toLowerCase());
    if (matches.length > 1) throw new Feature1ReadError(`More than one task has the code ${code}.`);
    const id = text(matches[0]?.id);
    if (!id) throw new Feature1ReadError(`Feature1 has no task with the code ${code}`);
    const task = (await mcp.call('get_task', { task_id: id })).structured ?? {};
    const status = text(task.status);
    if (STORY_FINISHED.includes(status)) {
      throw new Feature1ReadError(
        `"${text(task.title)}" is ${status.replace(/_/g, ' ')}. There is nothing left to build.`
      );
    }
    const description = [
      text(task.description),
      text(task.task_goal) ? `Goal: ${text(task.task_goal)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const unit: PulledStory = {
      id,
      code: text(task.code) || code,
      title: text(task.title) || 'Untitled task',
      description,
      status,
      acceptanceCriteria: [],
      dependencies: [],
      revision: digest([task.title, task.description, task.status, task.execution_steps]),
    };
    return {
      kind: 'task' satisfies WorkKind,
      id,
      code: unit.code,
      title: unit.title,
      description,
      status,
      projectId: text(task.project_id) || null,
      requirements: null,
      revision: unit.revision,
      stories: [unit],
      finished: [],
    };
  }

  /**
   * A note on a story or bug, as whoever connected the runner. Feature1's MCP
   * server has no notes on a feature or a task: false, and the pull request
   * has the note.
   */
  async note(mcpUrl: string, token: string, code: string, body: string): Promise<boolean> {
    const kind = workKindOf(code);
    if (kind !== 'story' && kind !== 'bug') return false;
    const mcp = new Feature1Mcp(mcpUrl, token, this.fetchImpl);
    try {
      const context = await mcp.call('get_story_change_context', { session_id: code });
      const revision = text(context.structured?.revision);
      if (!revision) return false;
      await mcp.call('add_user_story_comment', {
        session_id: code,
        expected_revision: revision,
        reason: body.slice(0, 5_000),
      });
      return true;
    } catch {
      return false;
    }
  }
}
