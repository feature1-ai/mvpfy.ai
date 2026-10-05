import { afterEach, expect, it, vi } from 'vitest';
import { prepareFeaturePreview, updateLocalDatabase } from './prepareFeaturePreview';
import type { Project } from '../../shared/types';
import type { RunsApi } from './useRuns';
afterEach(() => vi.unstubAllGlobals());
const project = {
  id: 'project',
  localPath: '/workspace',
  repos: [{ dir: '/workspace/app' }],
} as Project;
function fixture(codes: Array<number | null> = [0, 0]) {
  const calls: string[] = [];
  const api = {
    checkoutFeature: vi.fn(async () => {
      calls.push('checkout');
      return { ok: true };
    }),
    migrate: vi.fn(async () => {
      calls.push('migrate');
    }),
    dockerCompose: vi.fn(async () => {
      calls.push('restart');
    }),
  };
  vi.stubGlobal('window', { mvpfy: api });
  const runs = {
    track: vi.fn(() => {
      calls.push('track');
    }),
    fail: vi.fn(),
    completed: vi.fn(async () => {
      calls.push('complete');
      return codes.shift() ?? null;
    }),
  } as unknown as RunsApi;
  return { api, runs, calls };
}
it('tracks before migration IPC, awaits completion, then restarts and awaits startup', async () => {
  const { calls, api, runs } = fixture();
  await prepareFeaturePreview(project, 'billing', true, runs);
  expect(calls).toEqual([
    'checkout',
    'track',
    'migrate',
    'complete',
    'track',
    'restart',
    'complete',
  ]);
  expect(api.checkoutFeature).toHaveBeenCalledWith(
    '/workspace',
    ['/workspace/app'],
    'mvpfy/billing'
  );
  expect(api.dockerCompose).toHaveBeenCalledWith(expect.any(String), '/workspace', 'restart');
});
it.each([1, null])('does not restart after failed or stopped migration (%s)', async (code) => {
  const { api, runs } = fixture([code]);
  await expect(prepareFeaturePreview(project, 'billing', true, runs)).rejects.toThrow(
    'migration failed'
  );
  expect(api.dockerCompose).not.toHaveBeenCalled();
});
it('records startup/configuration errors in the tracked log', async () => {
  const { api, runs } = fixture();
  api.migrate.mockRejectedValue(new Error('Cannot verify database'));
  await expect(prepareFeaturePreview(project, 'billing', true, runs)).rejects.toThrow(
    'Cannot verify'
  );
  expect(runs.fail).toHaveBeenCalledWith(expect.any(String), 'Cannot verify database');
  expect(api.dockerCompose).not.toHaveBeenCalled();
});
it('does not migrate if checkout fails', async () => {
  const { api, runs } = fixture();
  api.checkoutFeature.mockResolvedValue({ ok: false });
  await expect(prepareFeaturePreview(project, 'billing', true, runs)).rejects.toThrow('switch');
  expect(api.migrate).not.toHaveBeenCalled();
});
it('reports restart failures after a successful migration', async () => {
  const { runs } = fixture([0, 1]);
  await expect(prepareFeaturePreview(project, 'billing', true, runs)).rejects.toThrow(
    'could not restart'
  );
});
it('leaves first-time environment setup to bootstrap', async () => {
  const { api, runs } = fixture();
  await prepareFeaturePreview(project, 'billing', false, runs);
  expect(api.migrate).not.toHaveBeenCalled();
});
it('also prepares the runtime when returning to trunk, without rolling back the database', async () => {
  const { api, runs } = fixture();
  await prepareFeaturePreview(project, null, true, runs);
  expect(api.checkoutFeature).toHaveBeenCalledWith('/workspace', ['/workspace/app'], null);
  expect(api.migrate).toHaveBeenCalled();
});

it('updates the current merged checkout without switching branches', async () => {
  const { api, runs, calls } = fixture();
  await updateLocalDatabase(project, runs);
  expect(api.checkoutFeature).not.toHaveBeenCalled();
  expect(calls).toEqual(['track', 'migrate', 'complete', 'track', 'restart', 'complete']);
});
