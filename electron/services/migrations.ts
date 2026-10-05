import * as fs from 'node:fs';
import * as path from 'node:path';
import { load } from 'js-yaml';
import { ENSURE_DAEMON, spawnEnv } from './docker';
import { shellQuote, spawnShellSync } from './shell';

interface MigrationStep {
  service: string;
  command: string[];
}
interface Service {
  image?: string;
  build?: { context?: string };
  working_dir?: string;
  volumes?: Array<{ type: string; source: string; target?: string }>;
  environment?: Record<string, string | null>;
}
interface ComposeConfig {
  services: Record<string, Service>;
}

export function detectedMigrationCommand(repo: string): string[] | null {
  const has = (file: string) => fs.existsSync(path.join(repo, file));
  if (has('Gemfile') && has('db/migrate')) return ['bundle', 'exec', 'rails', 'db:migrate'];
  if (has('manage.py')) return ['python', 'manage.py', 'migrate', '--noinput'];
  if (has('artisan')) return ['php', 'artisan', 'migrate', '--force'];
  if (has('prisma/schema.prisma')) return ['npx', '--no-install', 'prisma', 'migrate', 'deploy'];
  return null;
}

function readYaml(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const value = load(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${path.basename(file)}`);
  return value as Record<string, unknown>;
}

/** Exported separately so connection checks and command construction can be tested without Docker. */
export function buildMigrationCommand(
  base: string,
  config: ComposeConfig,
  steps: MigrationStep[]
): string {
  const commands: string[] = [];
  for (const step of steps) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(step.service) || !config.services[step.service]) {
      throw new Error(`Migration service "${step.service}" is not in the local Compose stack.`);
    }
    if (
      !Array.isArray(step.command) ||
      !step.command.length ||
      step.command.some((arg) => typeof arg !== 'string' || !arg || /[\r\n\0]/.test(arg))
    ) {
      throw new Error('Each migration command must be a non-empty list of arguments in mvpfy.yml.');
    }
    const env = config.services[step.service].environment ?? {};
    const databases = new Set<string>();
    let sqlite = env.DB_CONNECTION === 'sqlite';
    for (const [key, value] of Object.entries(env)) {
      if (
        !value ||
        !/^(DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|DB_URL|DB_HOST|DATABASE_HOST|PGHOST|MYSQL_HOST)$/i.test(
          key
        )
      )
        continue;
      if (/^(file:|sqlite:)/i.test(value)) {
        sqlite = true;
        continue;
      }
      let host = value;
      if (/URL$/i.test(key)) {
        try {
          host = new URL(value).hostname;
        } catch {
          throw new Error(
            `Cannot verify ${key} for migration service ${step.service}. Use a local database URL.`
          );
        }
      }
      const db = config.services[host];
      if (!db || !/(?:^|\/)(?:postgres|postgis|mysql|mariadb)(?::|\/|$)/i.test(db.image ?? '')) {
        // Never include the URL (which may contain a password) in an error or log.
        throw new Error(
          `Migration blocked: ${key} for ${step.service} does not point to a local Compose database service. Update the local environment before retrying.`
        );
      }
      databases.add(host);
    }
    if (!databases.size && !sqlite) {
      throw new Error(
        `Cannot verify the database for ${step.service}. Set DATABASE_URL or DB_HOST to its local Compose database service (or DB_CONNECTION=sqlite) before running migrations.`
      );
    }
    const service = config.services[step.service];
    const sqliteFile =
      env.DB_DATABASE ||
      (env.DATABASE_URL?.startsWith('sqlite:///')
        ? env.DATABASE_URL.slice('sqlite://'.length)
        : null);
    const persistedSqlite =
      sqliteFile?.startsWith('/') &&
      service.volumes?.some(
        (volume) =>
          volume.target &&
          (sqliteFile === volume.target ||
            sqliteFile.startsWith(volume.target.replace(/\/$/, '') + '/'))
      );
    if (sqlite && !persistedSqlite) {
      throw new Error(
        `SQLite migrations for ${step.service} need DB_DATABASE set to the absolute database path inside a shared volume, so the preview uses the same database.`
      );
    }
    commands.push(`${base} build ${shellQuote(step.service)}`);
    if (databases.size)
      commands.push(`${base} up -d --wait ${[...databases].map(shellQuote).join(' ')}`);
    // A one-off container works even when the app cannot boot until its schema is updated.
    // Override the entrypoint so an app startup script cannot swallow the migration command.
    commands.push(
      `${base} run --rm --no-deps -T --entrypoint ${shellQuote(step.command[0])} ${shellQuote(step.service)} ${step.command.slice(1).map(shellQuote).join(' ')}`
    );
  }
  return commands.length
    ? `${ENSURE_DAEMON} && ${commands.join(' && ')}`
    : 'echo No database migrations configured or detected.';
}

export function migrationCommandFor(workspace: string, linked: boolean, repos: string[]): string {
  const configDir = path.join(workspace, linked ? '.mvpfy' : '');
  const settings = readYaml(path.join(configDir, 'mvpfy.yml'));
  const explicit = settings.migrations;
  if (explicit !== undefined && !Array.isArray(explicit))
    throw new Error('migrations in mvpfy.yml must be a list of {service, command} entries.');
  if (Array.isArray(explicit) && explicit.length === 0)
    return 'echo No database migrations configured.';
  const detected = repos
    .map((repo) => ({ repo, command: detectedMigrationCommand(repo) }))
    .filter((item) => item.command);
  if (explicit === undefined && !detected.length) {
    // Unknown migration systems must not silently appear to have been applied.
    if (
      repos.some((repo) =>
        [
          'migrations',
          'db/migrate',
          'db/migrations',
          'prisma/migrations',
          'supabase/migrations',
          'drizzle',
          'alembic.ini',
        ].some((file) => fs.existsSync(path.join(repo, file)))
      )
    ) {
      throw new Error(
        'This project has migrations that mvpfy cannot infer. Add a migrations entry with its app service and command to mvpfy.yml, then retry Test this feature.'
      );
    }
    return 'echo No database migrations configured or detected.';
  }
  const base = linked
    ? 'docker compose -f .mvpfy/docker-compose.mvpfy.yml --project-directory .'
    : 'docker compose -f docker-compose.mvpfy.yml';
  const result = spawnShellSync(`${base} config --format json`, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 30_000,
    env: spawnEnv(),
  });
  if (result.status !== 0)
    throw new Error(
      'Cannot read the local Compose configuration. Set up the environment before testing this feature.'
    );
  const config = JSON.parse(result.stdout) as ComposeConfig;
  if (!config.services) throw new Error('The local Compose configuration has no services.');
  const steps: MigrationStep[] =
    explicit === undefined
      ? detected.map(({ repo, command }) => {
          const services = Object.entries(config.services).filter(
            ([, service]) =>
              (service.build?.context &&
                path.resolve(service.build.context) === path.resolve(repo)) ||
              service.volumes?.some(
                (volume) =>
                  volume.type === 'bind' && path.resolve(volume.source) === path.resolve(repo)
              )
          );
          if (services.length !== 1)
            throw new Error(
              `Cannot choose the migration service for ${path.basename(repo)}. Add migrations: [{service: app, command: [...]}] to mvpfy.yml, then retry.`
            );
          return { service: services[0][0], command: command! };
        })
      : (explicit as MigrationStep[]);
  if (steps.some((step) => !step || typeof step.service !== 'string'))
    throw new Error('Each migrations entry needs a service and a command argument list.');
  return buildMigrationCommand(base, config, steps);
}
