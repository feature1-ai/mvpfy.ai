import * as crypto from 'node:crypto';
import { Execution, PROTOCOL_VERSION, Snapshot } from '../shared/runner/contract';
import { PulledFeature, PulledStory } from './feature1Reader';
import { Project, uuidFor } from './project';

/**
 * Turning a pulled feature into work the engine can do.
 *
 * The engine builds an `Execution`: a frozen copy of the requirements and the
 * repositories they are to be built in. When Feature1 hands work to a runner
 * it makes that itself. When the runner pulls, this makes the same thing from
 * the feature it read and the project it was told about — so everything after
 * this point, from the first clone to the pull request, is the one path, and
 * a pulled feature is built exactly as a dispatched one is.
 */

const digestOf = (value: unknown) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function storySnapshot(story: PulledStory): Snapshot {
  const snapshot = {
    type: 'story' as const,
    id: story.id,
    code: story.code,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria,
    executionSteps: [],
    taskGoal: null,
    dependencies: story.dependencies,
    revision: story.revision,
  };
  return { ...snapshot, digest: digestOf(snapshot) };
}

export function snapshotOf(feature: PulledFeature, instructions = ''): Snapshot {
  const snapshot = {
    type: 'feature' as const,
    id: feature.id,
    code: feature.code,
    title: feature.title,
    description: feature.description,
    acceptanceCriteria: [],
    executionSteps: [],
    taskGoal: null,
    requirements: feature.requirements,
    dependencies: [],
    revision: feature.revision,
    stories: feature.stories.map(storySnapshot),
    instructions,
  };
  return { ...snapshot, digest: digestOf(snapshot) };
}

/**
 * The lease pulled work is held under: longer than any build. Nobody else is
 * handed pulled work, so its lease has nothing to fence off; with Feature1's
 * three minutes, a laptop that slept woke to a lapsed lease and the finished
 * work was thrown away before it was committed.
 */
export const PULLED_LEASE_MS = 30 * 24 * 60 * 60_000;

export class NothingToBuildError extends Error {}

export function executionFor(
  feature: PulledFeature,
  project: Project,
  who: { tenantId: string; userId: string },
  options: { instructions?: string; newId?: () => string } = {}
): Execution {
  if (feature.stories.length === 0 && feature.finished.length > 0) {
    // Without this the engine would build the feature as one unit, from its
    // title, over the top of stories that are already done.
    throw new NothingToBuildError(
      `Every story of "${feature.title}" is already finished (${feature.finished.length}). ` +
        'There is nothing left to build.'
    );
  }
  const newId = options.newId ?? (() => crypto.randomUUID());
  const featureId = uuidFor(feature.id);
  return {
    protocol_version: PROTOCOL_VERSION,
    id: newId(),
    tenant_id: uuidFor(who.tenantId),
    project_id: uuidFor(feature.projectId ?? feature.id),
    requested_by: who.userId,
    origin_type: 'feature',
    origin_id: featureId,
    owner_type: 'feature',
    owner_id: featureId,
    assistant_thread_id: null,
    request_key: newId(),
    snapshot: snapshotOf(feature, options.instructions ?? ''),
    repositories: project.repositories,
    state: 'queued',
    attempt: 0,
    results: {},
    clarifications: [],
    message: null,
    // Issued when the work is claimed, as it is for any other execution.
    lease_token: '',
    lease_until: null,
  };
}
