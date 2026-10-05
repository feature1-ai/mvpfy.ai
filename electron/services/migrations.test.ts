import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMigrationCommand, detectedMigrationCommand, migrationCommandFor } from './migrations';
import { spawnShellSync } from './shell';
vi.mock('./shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shell')>()),
  spawnShellSync: vi.fn(),
}));
vi.mock('./docker', () => ({ ENSURE_DAEMON: 'docker info', spawnEnv: () => ({}) }));
const dirs: string[] = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-migrations-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});
const base = 'docker compose -f docker-compose.mvpfy.yml';
const step = { service: 'app', command: ['bundle', 'exec', 'rails', 'db:migrate'] };
const config = {
  services: {
    app: { environment: { DATABASE_URL: 'postgres://demo:secret@db/app' } },
    db: { image: 'postgres:16' },
  },
};
describe('local database migrations', () => {
  it('starts the local database before running migrations in an app container, without its startup entrypoint', () => {
    const cmd = buildMigrationCommand(base, config, [step]);
    expect(cmd).toMatch(/up -d --wait .*db.* && .*run --rm --no-deps -T --entrypoint/);
    expect(cmd).toContain('db:migrate');
    expect(cmd).not.toContain('secret');
    expect(cmd).not.toContain('down');
    expect(cmd).not.toContain('--volumes');
  });
  it.each([
    'postgres://user:secret@production.example/db',
    'postgres://user:secret@localhost/db',
    'invalid-secret-url',
  ])('rejects remote or unverifiable connections without exposing credentials', (url) => {
    try {
      buildMigrationCommand(base, { services: { app: { environment: { DATABASE_URL: url } } } }, [
        step,
      ]);
      throw new Error('did not reject');
    } catch (error) {
      expect(String(error)).toMatch(/local|verify/);
      expect(String(error)).not.toContain('secret');
    }
  });
  it('checks direct database URLs too, not just the primary URL', () => {
    expect(() =>
      buildMigrationCommand(
        base,
        {
          services: {
            ...config.services,
            app: {
              environment: {
                ...config.services.app.environment,
                DIRECT_URL: 'postgres://remote.example/db',
              },
            },
          },
        },
        [step]
      )
    ).toThrow('DIRECT_URL');
  });
  it('rejects absent database settings and unknown services', () => {
    expect(() => buildMigrationCommand(base, { services: { app: {} } }, [step])).toThrow(
      'Cannot verify'
    );
    expect(() => buildMigrationCommand(base, config, [{ ...step, service: 'other' }])).toThrow(
      'not in'
    );
  });
  it('requires a persistent known path for SQLite', () => {
    const app = {
      environment: { DB_CONNECTION: 'sqlite', DB_DATABASE: '/data/db.sqlite' },
      volumes: [{ type: 'volume', source: 'db', target: '/data' }],
    };
    expect(buildMigrationCommand(base, { services: { app } }, [step])).toContain('run --rm');
    expect(() =>
      buildMigrationCommand(base, { services: { app: { ...app, volumes: [] } } }, [step])
    ).toThrow('shared volume');
    expect(() =>
      buildMigrationCommand(
        base,
        {
          services: {
            app: {
              ...app,
              environment: { DB_CONNECTION: 'sqlite', DB_DATABASE: '/tmp/db.sqlite' },
            },
          },
        },
        [step]
      )
    ).toThrow('shared volume');
  });
  it('validates command argument lists', () => {
    expect(() => buildMigrationCommand(base, config, [{ ...step, command: [] }])).toThrow(
      'argument'
    );
    expect(() =>
      buildMigrationCommand(base, config, [{ ...step, command: ['rails\ndb:drop'] }])
    ).toThrow('argument');
  });
  it.each([
    ['Gemfile', 'db/migrate', 'db:migrate'],
    ['manage.py', null, '--noinput'],
    ['artisan', null, '--force'],
    ['prisma/schema.prisma', null, 'deploy'],
  ])('detects %s without destructive resets', (marker, folder, last) => {
    const repo = temp();
    fs.mkdirSync(path.dirname(path.join(repo, marker!)), { recursive: true });
    fs.writeFileSync(path.join(repo, marker!), '');
    if (folder) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    expect(detectedMigrationCommand(repo)?.at(-1)).toBe(last);
  });
  it('uses linked configuration and fails on ambiguous app/worker mapping', () => {
    const root = temp();
    const repo = path.join(root, 'backend');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'manage.py'), '');
    fs.mkdirSync(path.join(root, '.mvpfy'));
    const resolved = {
      services: {
        ...config.services,
        app: { ...config.services.app, build: { context: repo } },
        worker: { build: { context: repo } },
      },
    };
    vi.mocked(spawnShellSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify(resolved),
    } as ReturnType<typeof spawnShellSync>);
    expect(() => migrationCommandFor(root, true, [repo])).toThrow('Cannot choose');
    fs.writeFileSync(
      path.join(root, '.mvpfy', 'mvpfy.yml'),
      'migrations:\n  - service: app\n    command: [python, manage.py, migrate, --noinput]\n'
    );
    expect(migrationCommandFor(root, true, [repo])).toContain(
      '-f .mvpfy/docker-compose.mvpfy.yml --project-directory .'
    );
  });
  it('does not silently skip unknown migration systems', () => {
    const repo = temp();
    fs.mkdirSync(path.join(repo, 'drizzle'));
    expect(() => migrationCommandFor(repo, false, [repo])).toThrow('cannot infer');
  });
  it('skips projects without database migrations', () => {
    const repo = temp();
    expect(migrationCommandFor(repo, false, [repo])).toContain('No database migrations');
    expect(spawnShellSync).not.toHaveBeenCalled();
  });
});

it('supports explicitly opting out without requiring Docker configuration', () => {
  const repo = temp();
  fs.writeFileSync(path.join(repo, 'mvpfy.yml'), 'migrations: []');
  expect(migrationCommandFor(repo, false, [repo])).toContain('No database migrations');
  expect(spawnShellSync).not.toHaveBeenCalled();
});
