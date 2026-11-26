import { AcceptanceCriterion } from '../shared/runner/contract';
import { UUID } from '../shared/runner/validate';
import { Feature1LoginError } from './feature1Login';

/**
 * Reading a feature out of Feature1, the way a person's own tools do.
 *
 * The desktop app pulls a feature with the signed-in person's token and builds
 * it. This is that pull for a runner: the feature, its approved requirements,
 * and the stories still to be built, each with its acceptance criteria.
 *
 * These are the same endpoints Feature1's MCP server reads. Their rows carry
 * a field under more than one spelling depending on where they came from, so
 * each value is looked for under every name the server itself accepts
 * (mcp-server/feature-management.js and user-story.js in Feature1). Nothing
 * here writes.
 */

export class Feature1ReadError extends Error {}

export interface PulledStory {
  /** The story's workflow session id. */
  id: string;
  code: string | null;
  title: string;
  description: string;
  status: string;
  acceptanceCriteria: AcceptanceCriterion[];
  dependencies: unknown[];
  revision: string | null;
}

/** What a person can ask to have built, by the type part of its code. */
export type WorkKind = 'feature' | 'story' | 'bug' | 'task';

/** The kind of work a code names: THA-F-11, THA-US-52, THA-BUG-3, THA-T-8. Null for an id. */
export function workKindOf(reference: string): WorkKind | 'spike' | null {
  const type = reference
    .trim()
    .toUpperCase()
    .match(/-([A-Z]+)-\d+$/)?.[1];
  return type === 'F'
    ? 'feature'
    : type === 'US'
      ? 'story'
      : type === 'BUG'
        ? 'bug'
        : type === 'T'
          ? 'task'
          : type === 'SPK'
            ? 'spike'
            : null;
}

export interface PulledFeature {
  /**
   * What was asked for. A story, bug or task is built on its own: it is
   * then the one entry in `stories`, and the snapshot is the item itself.
   * Absent means a feature.
   */
  kind?: WorkKind;
  id: string;
  code: string | null;
  title: string;
  description: string;
  status: string;
  projectId: string | null;
  /** The approved PRD, as Feature1 holds it. */
  requirements: unknown;
  revision: string | null;
  /** Unfinished stories, in the order Feature1 generated them. */
  stories: PulledStory[];
  /** Stories left out because they are already finished. */
  finished: Array<{ title: string; status: string }>;
}

type Row = Record<string, unknown>;

const row = (value: unknown): Row => (value && typeof value === 'object' ? (value as Row) : {});
const text = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
};
const parsed = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

/** The list Feature1 uses when it decides whether a feature may be queued. */
export const FEATURE_CLOSED = [
  'done',
  'completed',
  'cancelled',
  'archived',
  'communicate',
  'measure',
];
/**
 * Stories not to build again. Feature1's own list, and one more: a story
 * ready for testing has been implemented and is waiting for a person. Feature1
 * leaves those in what it queues; built again here, they are hours of agent
 * time spent redoing work somebody is about to test.
 */
export const STORY_FINISHED = [
  'completed',
  'done',
  'cancelled',
  'archived',
  'ready_for_completion',
  'testing_passed',
  'ready_for_testing',
];

function featureCode(feature: Row): string {
  return text(feature.code, feature.feature_code, feature.featureCode);
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

/** One story, from its own record laid over the row the feature's list gave. */
export function storyFrom(listed: Row, detailed: Row = {}): PulledStory {
  const raw = { ...listed, ...detailed };
  const state = row(parsed(raw.stateData ?? raw.state_data));
  const input = raw.userStory ?? raw.user_story ?? state.userStory;
  const narrative = row(input);
  const firstLine = typeof input === 'string' ? (input.split('\n')[0] ?? '') : '';
  return {
    id: text(raw.sessionId, raw.session_id, raw.workflow_id, raw.workflowId, raw.id),
    code: text(raw.code, raw.story_code, raw.storyCode) || null,
    // What the story says of itself before what a list row calls it: the row's
    // title is a summary and can lag behind an edit.
    title:
      text(
        raw.userStoryTitle,
        raw.user_story_title,
        state.userStoryTitle,
        narrative.title,
        raw.title,
        firstLine
      ) || 'Untitled story',
    description: text(
      raw.userStoryDescription,
      raw.user_story_description,
      narrative.description,
      raw.description,
      state.userStoryDescription,
      typeof input === 'string' ? input : ''
    ),
    status: text(
      raw.workflowStatus,
      raw.workflow_status,
      raw.status,
      state.workflowStatus,
      state.status
    ),
    acceptanceCriteria: criteria(
      raw.acceptanceCriteria ?? raw.acceptance_criteria ?? state.acceptanceCriteria
    ),
    dependencies: Array.isArray(state.dependencies) ? state.dependencies : [],
    revision: text(raw.updatedAt, raw.updated_at) || null,
  };
}

export class Feature1Reader {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async get(baseUrl: string, token: string, path: string): Promise<Row> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/api${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Feature1ReadError(`Feature1 could not be reached: ${(error as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Feature1LoginError(
        'Feature1 rejected the saved sign-in. Run `setup` again to sign in.'
      );
    }
    let body: Row = {};
    try {
      body = row(await response.json());
    } catch {
      // Handled as a failed read, below.
    }
    if (!response.ok || body.success === false) {
      const reason = text(body.error, body.message) || `HTTP ${response.status}`;
      throw new Feature1ReadError(`Feature1 would not return ${path}: ${reason}`);
    }
    return body;
  }

  /** A feature's UUID, from its UUID or from the code a person reads on the card. */
  private async resolve(baseUrl: string, token: string, ref: string): Promise<string> {
    if (UUID.test(ref)) return ref;
    const query = new URLSearchParams({ search: ref, pageSize: '20', limit: '20' });
    const found = await this.get(baseUrl, token, `/feature-planning?${query}`);
    const wanted = ref.toLowerCase();
    const matches = (Array.isArray(found.features) ? found.features : [])
      .map(row)
      .filter((feature) => featureCode(feature).toLowerCase() === wanted);
    if (matches.length > 1) {
      throw new Feature1ReadError(`More than one feature has the code ${ref}. Use its id instead.`);
    }
    const id = text(matches[0]?.id);
    if (!id) throw new Feature1ReadError(`Feature1 has no feature with the code ${ref}`);
    return id;
  }

  /**
   * A note on a feature, story or bug in Feature1, as the runner's user: how
   * a change made beside its test link is told to the people who planned it.
   * A task has no notes of its own; false when there is nowhere to put it.
   */
  async note(baseUrl: string, token: string, code: string, body: string): Promise<boolean> {
    const kind = workKindOf(code);
    let path: string;
    if (kind === 'feature' || kind === null) {
      path = `/feature-planning/${await this.resolve(baseUrl, token, code)}/comments`;
    } else if (kind === 'story' || kind === 'bug') {
      const query = new URLSearchParams({ search: code, includeGenerated: 'true', limit: '20' });
      const found = await this.get(baseUrl, token, `/workflows?${query}`);
      const match = (Array.isArray(found.workflows) ? found.workflows : [])
        .map(row)
        .find((w) => text(w.code).toLowerCase() === code.toLowerCase());
      const id = match ? storyFrom(match).id : '';
      if (!id) return false;
      path = `/workflows/${encodeURIComponent(id)}/comments`;
    } else {
      return false;
    }
    try {
      const response = await this.fetchImpl(`${baseUrl}/api${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: body.slice(0, 10_000) }),
        signal: AbortSignal.timeout(30_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** The feature and everything of it still to be built. */
  async pullFeature(baseUrl: string, token: string, reference: string): Promise<PulledFeature> {
    const ref = reference.trim();
    if (!ref) throw new Feature1ReadError('A feature code or id is needed');
    const id = await this.resolve(baseUrl, token, ref);
    const feature = row((await this.get(baseUrl, token, `/feature-planning/${id}`)).feature);
    if (!text(feature.id)) throw new Feature1ReadError(`Feature1 returned no feature for ${ref}`);

    const status = text(feature.status);
    const title = text(feature.title) || 'Untitled feature';
    // The rules Feature1 applies before it will queue a feature itself.
    if (status === 'draft') {
      throw new Feature1ReadError(
        `"${title}" is still a draft. Approve its scope in Feature1 first.`
      );
    }
    if (FEATURE_CLOSED.includes(status)) {
      throw new Feature1ReadError(`"${title}" is ${status}. Reopen it in Feature1 to build it.`);
    }

    const listed = await this.get(baseUrl, token, `/feature-planning/${id}/workflows`);
    const stories: PulledStory[] = [];
    const finished: PulledFeature['finished'] = [];
    for (const item of (Array.isArray(listed.workflows) ? listed.workflows : []).map(row)) {
      const brief = storyFrom(item);
      if (!brief.id) continue;
      if (STORY_FINISHED.includes(brief.status)) {
        finished.push({ title: brief.title, status: brief.status });
        continue;
      }
      // The list row is a summary; the story's own record has its criteria.
      const detail = row((await this.get(baseUrl, token, `/workflows/${brief.id}`)).workflow);
      stories.push(storyFrom(item, detail));
    }

    const analysis = row(
      parsed(feature.analysis_result ?? feature.analysisResult ?? feature.analysis)
    );
    return {
      id: text(feature.id),
      code: featureCode(feature) || null,
      title,
      description: text(feature.description),
      status,
      projectId: text(feature.project_id, feature.projectId, row(feature.project).id) || null,
      requirements: parsed(analysis.prd ?? feature.prd) ?? null,
      revision: text(feature.updated_at, feature.updatedAt) || null,
      stories,
      finished,
    };
  }

  /**
   * Whatever the code names: a feature and its unfinished stories, or one
   * story, bug or task on its own. An id is taken to be a feature's.
   */
  async pullWork(baseUrl: string, token: string, reference: string): Promise<PulledFeature> {
    const ref = reference.trim();
    const kind = workKindOf(ref);
    if (kind === 'spike') {
      throw new Feature1ReadError(`${ref} is a spike: research to do, not something to build.`);
    }
    if (kind === 'story' || kind === 'bug') return this.pullStory(baseUrl, token, ref, kind);
    if (kind === 'task') return this.pullTask(baseUrl, token, ref);
    return this.pullFeature(baseUrl, token, ref);
  }

  /** One story or bug, with its criteria, built on its own. */
  private async pullStory(
    baseUrl: string,
    token: string,
    code: string,
    kind: 'story' | 'bug'
  ): Promise<PulledFeature> {
    const query = new URLSearchParams({ search: code, includeGenerated: 'true', limit: '20' });
    const found = await this.get(baseUrl, token, `/workflows?${query}`);
    const matches = (Array.isArray(found.workflows) ? found.workflows : [])
      .map(row)
      .filter((w) => text(w.code).toLowerCase() === code.toLowerCase());
    if (matches.length > 1) throw new Feature1ReadError(`More than one item has the code ${code}.`);
    const listed = matches[0];
    const brief = listed ? storyFrom(listed) : null;
    if (!listed || !brief?.id)
      throw new Feature1ReadError(`Feature1 has no ${kind} with the code ${code}`);
    if (STORY_FINISHED.includes(brief.status)) {
      throw new Feature1ReadError(
        `"${brief.title}" is ${brief.status.replace(/_/g, ' ')}. There is nothing left to build.`
      );
    }
    const detail = row((await this.get(baseUrl, token, `/workflows/${brief.id}`)).workflow);
    const story = storyFrom(listed, detail);
    return {
      kind,
      id: story.id,
      code: story.code ?? code,
      title: story.title,
      description: story.description,
      status: story.status,
      projectId: text(listed.project_id, listed.projectId, detail.project_id) || null,
      requirements: null,
      revision: story.revision,
      stories: [story],
      finished: [],
    };
  }

  /** One task, built on its own. */
  private async pullTask(baseUrl: string, token: string, code: string): Promise<PulledFeature> {
    const query = new URLSearchParams({ search: code, limit: '20' });
    const found = await this.get(baseUrl, token, `/tasks?${query}`);
    const rows = Array.isArray(found.tasks)
      ? found.tasks
      : Array.isArray(found.data)
        ? found.data
        : [];
    const matches = rows.map(row).filter((t) => text(t.code).toLowerCase() === code.toLowerCase());
    if (matches.length > 1) throw new Feature1ReadError(`More than one task has the code ${code}.`);
    const task = matches[0];
    if (!task || !text(task.id))
      throw new Feature1ReadError(`Feature1 has no task with the code ${code}`);
    const status = text(task.status);
    if (STORY_FINISHED.includes(status)) {
      throw new Feature1ReadError(
        `"${text(task.title)}" is ${status.replace(/_/g, ' ')}. There is nothing left to build.`
      );
    }
    const unit: PulledStory = {
      id: text(task.id),
      code: text(task.code) || code,
      title: text(task.title) || 'Untitled task',
      description: text(task.description),
      status,
      acceptanceCriteria: criteria(task.acceptance_criteria ?? task.acceptanceCriteria),
      dependencies: [],
      revision: text(task.updated_at, task.updatedAt) || null,
    };
    return {
      kind: 'task',
      id: unit.id,
      code: unit.code,
      title: unit.title,
      description: unit.description,
      status,
      projectId: text(task.project_id, task.projectId) || null,
      requirements: null,
      revision: unit.revision,
      stories: [unit],
      finished: [],
    };
  }
}
