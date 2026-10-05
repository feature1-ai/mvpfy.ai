import type { Project } from '../../shared/types';
import type { RunsApi } from './useRuns';
import { makeRunId } from './agentRunner';

/** Await each stage; never announce a feature ready after a failed migration. */
export async function prepareFeaturePreview(
  project: Project,
  slug: string | null,
  hasRuntime: boolean,
  runs: RunsApi
): Promise<void> {
  const result = await window.mvpfy.checkoutFeature(
    project.localPath,
    project.repos.map((repo) => repo.dir),
    slug === null ? null : `mvpfy/${slug || 'feature'}`
  );
  if (!result.ok) throw new Error(result.error || 'Could not switch the workspace to that branch');
  // A brand-new product has no runtime yet. Its first setup will establish the schema.
  if (!hasRuntime) return;
  await updateLocalDatabase(project, runs, slug ?? '');
}

/** Applies merged/current checkout migrations without changing branches or pulling code. */
export async function updateLocalDatabase(
  project: Project,
  runs: RunsApi,
  planSlug?: string
): Promise<void> {
  for (const kind of ['migrate', 'docker-up'] as const) {
    const runId = makeRunId(kind);
    runs.track({
      runId,
      kind,
      projectId: project.id,
      ...(planSlug !== undefined ? { planSlug } : {}),
    });
    try {
      if (kind === 'migrate')
        await window.mvpfy.migrate(
          runId,
          project.localPath,
          project.repos.map((repo) => repo.dir)
        );
      else await window.mvpfy.dockerCompose(runId, project.localPath, 'restart');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runs.fail(runId, message);
      throw new Error(message, { cause: error });
    }
    if ((await runs.completed(runId)) !== 0) {
      throw new Error(
        kind === 'migrate'
          ? 'Database migration failed or was stopped. The local database is not ready. Open the activity logs, fix the reported issue, then retry.'
          : 'The database was updated, but the app could not restart. Open the activity logs, fix the startup error, then retry.'
      );
    }
  }
}
