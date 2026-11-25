import * as fs from 'node:fs';
import * as path from 'node:path';
import { manifestPorts } from '../shared/manifest';
import { CommandRunner } from './exec';
import { RECIPE_DIR } from './prepare';

/**
 * Starting a product from a branch, so somebody can try it.
 *
 * In the sandbox, on the tenant's own Docker engine: the prepared recipe is
 * laid over a checkout of the branch and the stack brought up the way the
 * desktop app brings one up. What comes back is where the product answers and
 * the login to try it with; the link itself is mvpfy-cloud's to make.
 *
 * Every compose command runs under COMPOSE_PROJECT_NAME rather than `-p`, so
 * the seed command the recipe records — written as a plain `docker compose`
 * line — reaches the same stack.
 */

/** Chosen by mvpfy-cloud. It becomes a host name and a compose project name. */
export const PREVIEW_NAME = /^p[a-z0-9]{12}$/;

export interface DemoLogin {
  email?: string;
  password?: string;
}

export interface PreviewRecord {
  name: string;
  branch: string;
  commit: string;
  /** The port the product answers on, on the tenant's engine. */
  port: number;
  /** The path the product is opened at. */
  path: string;
  demoLogin: DemoLogin | null;
  /** The phone app's development server, when the product is a mobile app. */
  mobile?: MobileApp;
  startedAt: string;
}

/**
 * A mobile app's development server, as setup recorded it in mvpfy.yml's
 * `mobile:` block: what kind, the port it listens on, and the one line the
 * person trying it is told.
 */
export interface MobileApp {
  kind: string;
  port: number | null;
  note: string | null;
}

/**
 * Where a test link is reached from outside, given by mvpfy-cloud: the web
 * address, and the address a phone's Expo Go opens the app at.
 */
export interface LinkAddresses {
  web: string;
  expo: string;
}

export class PreviewError extends Error {}

/** `docker compose` for a prepared checkout. */
export const COMPOSE = `docker compose -f ${RECIPE_DIR}/docker-compose.mvpfy.yml --project-directory .`;

/** What a test link adds over the recipe: written per link, never kept in the recipe. */
export const LINK_OVERRIDE = `${RECIPE_DIR}/docker-compose.link.yml`;

function composeFor(checkout: string): string {
  return fs.existsSync(path.join(checkout, LINK_OVERRIDE))
    ? COMPOSE.replace(' --project-directory', ` -f ${LINK_OVERRIDE} --project-directory`)
    : COMPOSE;
}

export function recipeManifest(checkout: string): string {
  const file = path.join(checkout, RECIPE_DIR, 'mvpfy.yml');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new PreviewError('The recipe has no mvpfy.yml. Run `prepare` again.');
  }
}

/** Where the product answers, from what setup recorded. */
export function entryOf(manifest: string): { port: number; path: string } {
  const { hostPort, urlPort } = manifestPorts(manifest);
  // A phone app with no web build is reached through its development server.
  const port = hostPort ?? urlPort ?? mobileOf(manifest)?.port;
  if (!port) throw new PreviewError("The recipe's mvpfy.yml does not say which port the app is on");
  const url = manifest.match(
    /^\s*url:\s*["']?https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(\/[^\s"']*)?/m
  );
  return { port, path: url?.[1] || '/' };
}

/** The one seed line setup recorded, as the desktop reads it. */
export function seedCommandOf(manifest: string): string | null {
  const match = manifest.match(/^\s*seed_command:\s*(?:["']([^"']+)["']|([^\n#]+))/m);
  const command = (match?.[1] ?? match?.[2] ?? '').trim();
  return command && !command.includes('\n') ? command : null;
}

/** The recipe's `mobile:` block, read without a YAML library (the worker ships none). */
export function mobileOf(manifest: string): MobileApp | null {
  const lines = manifest.split('\n');
  const start = lines.findIndex((line) => /^mobile:\s*$/.test(line));
  if (start === -1) return null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const field = line.match(/^\s+(kind|expo_url|expoUrl|note|port):\s*["']?(.*?)["']?\s*$/);
    if (field?.[1] && field[2] !== undefined) fields[field[1]] = field[2];
  }
  const kind = (fields.kind ?? '').trim().toLowerCase();
  const address = fields.expo_url ?? fields.expoUrl ?? '';
  const stated = Number(fields.port ?? address.match(/:(\d{2,5})(?:\/|$)/)?.[1]);
  const isExpo = kind === 'expo' || /^exps?:\/\//.test(address);
  const port =
    Number.isInteger(stated) && stated > 0 && stated < 65536 ? stated : isExpo ? 8081 : null;
  if (!kind && !address && !fields.note) return null;
  return { kind: kind || (isExpo ? 'expo' : 'mobile'), port, note: fields.note?.trim() || null };
}

/**
 * The compose service that publishes this port, read without a YAML
 * library: the service whose `ports:` maps to it. Null when none does.
 */
export function serviceOnPort(composeFile: string, port: number): string | null {
  let inServices = false;
  let current: string | null = null;
  const published = new RegExp(
    `(?:^\\s*-\\s*["']?|:)(?:\\$\\{[^}]*\\}:)?${port}(?:/tcp)?["']?\\s*$|^\\s*(?:target|published):\\s*["']?${port}["']?\\s*$`
  );
  for (const line of composeFile.split('\n')) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (/^\S/.test(line)) inServices = false;
    if (!inServices) continue;
    const service = line.match(/^ {2}([A-Za-z0-9._-]+):\s*$/);
    if (service?.[1]) current = service[1];
    else if (current && published.test(line)) return current;
  }
  return null;
}

/**
 * Point an Expo development server at the link's own address.
 *
 * Expo Go opens the app from the manifest the server hands it, and every
 * address in that manifest is where the server thinks it is: a container's,
 * which no phone can reach. EXPO_PACKAGER_PROXY_URL makes them the link's.
 * MVPFY_LINK_URL is the web link, for an app built to call its own backend
 * there. Written as an override beside the recipe, so the recipe itself
 * stays as setup left it.
 */
export function writeExpoOverride(
  checkout: string,
  mobile: MobileApp,
  addresses: LinkAddresses
): string | null {
  if (mobile.kind !== 'expo' || !mobile.port) return null;
  let composeFile: string;
  try {
    composeFile = fs.readFileSync(
      path.join(checkout, RECIPE_DIR, 'docker-compose.mvpfy.yml'),
      'utf8'
    );
  } catch {
    return null;
  }
  const service = serviceOnPort(composeFile, mobile.port);
  if (!service) return null;
  const quoted = (value: string) => JSON.stringify(value);
  fs.writeFileSync(
    path.join(checkout, LINK_OVERRIDE),
    [
      'services:',
      `  ${service}:`,
      '    environment:',
      `      EXPO_PACKAGER_PROXY_URL: ${quoted(addresses.expo)}`,
      `      MVPFY_LINK_URL: ${quoted(addresses.web)}`,
      '',
    ].join('\n')
  );
  return service;
}

/** The demo login from the recipe's `demo_login:` block, read without a YAML library. */
export function demoLoginOf(manifest: string): DemoLogin | null {
  const lines = manifest.split('\n');
  const start = lines.findIndex((line) => /^demo_login:\s*$/.test(line));
  if (start === -1) return null;
  const login: DemoLogin = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const field = line.match(/^\s+(email|username|password):\s*["']?([^"'#\n]+?)["']?\s*$/);
    if (!field) continue;
    if (field[1] === 'password') login.password = field[2];
    else login.email ??= field[2];
  }
  return login.email || login.password ? login : null;
}

export interface StartDeps {
  /** The sandbox. */
  runner: CommandRunner;
  /** The sandbox's environment: the engine's address and nothing of the worker's. */
  env: NodeJS.ProcessEnv;
  /** The engine's host name, where the product is reached. */
  engineHostname: string;
  fetchImpl?: typeof fetch;
  log: (message: string) => void;
  /** How long the product gets to answer once its containers are up. */
  readyWithinMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The link's public web address, given to compose as MVPFY_LINK_URL. */
  linkUrl?: string;
}

async function compose(
  deps: StartDeps,
  checkout: string,
  name: string,
  args: string,
  timeoutMs: number
): Promise<void> {
  const result = await deps.runner.run(`${composeFor(checkout)} ${args}`, {
    cwd: checkout,
    env: {
      ...deps.env,
      COMPOSE_PROJECT_NAME: name,
      ...(deps.linkUrl ? { MVPFY_LINK_URL: deps.linkUrl } : {}),
    },
    timeoutMs,
  });
  if (result.code !== 0) {
    const said = (result.stderr || result.stdout).trim().slice(-1500);
    throw new PreviewError(`\`docker compose ${args}\` failed:\n${said || '(nothing printed)'}`);
  }
}

/** Waits for the product to answer anything but a server error. */
async function answers(deps: StartDeps, url: string): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (deps.readyWithinMs ?? 10 * 60_000);
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status < 500) return true;
    } catch {
      // Not up yet.
    }
    await sleep(3_000);
  }
  return false;
}

/** Bring the stack up in a prepared checkout of the branch, and wait for it to answer. */
export async function startPreview(
  checkout: string,
  meta: { name: string; branch: string; commit: string },
  deps: StartDeps,
  addresses?: LinkAddresses
): Promise<PreviewRecord> {
  if (!PREVIEW_NAME.test(meta.name)) throw new PreviewError(`Not a preview name: ${meta.name}`);
  if (addresses) deps = { ...deps, linkUrl: addresses.web };
  const manifest = recipeManifest(checkout);
  const entry = entryOf(manifest);
  const mobile = mobileOf(manifest);
  if (mobile?.kind === 'expo' && addresses) {
    const service = writeExpoOverride(checkout, mobile, addresses);
    deps.log(
      service
        ? `the phone app is served by ${service} at ${addresses.expo}`
        : `no service publishes the phone app's port ${mobile.port}, so Expo Go cannot open it`
    );
  }

  deps.log(`starting ${meta.branch} at ${meta.commit.slice(0, 12)}`);
  await clearEngine(deps, checkout);
  await compose(deps, checkout, meta.name, 'up -d --build --remove-orphans', 45 * 60_000);

  const url = `http://${deps.engineHostname}:${entry.port}${entry.path}`;
  deps.log(`waiting for the product to answer on port ${entry.port}`);
  if (!(await answers(deps, url))) {
    throw new PreviewError(
      `The containers started, but nothing answered on port ${entry.port} in time. ` +
        'The stack may need setting up again with `prepare`.'
    );
  }

  const seed = seedCommandOf(manifest);
  if (seed) {
    deps.log('adding the sample data');
    const seeded = await deps.runner.run(seed, {
      cwd: checkout,
      env: { ...deps.env, COMPOSE_PROJECT_NAME: meta.name },
      timeoutMs: 15 * 60_000,
    });
    // A seed that fails leaves an app that still opens; say so and go on.
    if (seeded.code !== 0) deps.log('the sample data did not load; the demo login may not work');
  }

  return {
    ...meta,
    port: entry.port,
    path: entry.path,
    demoLogin: demoLoginOf(manifest),
    ...(mobile ? { mobile } : {}),
    startedAt: new Date().toISOString(),
  };
}

/** Take a preview's stack away, data and all: nothing about it outlives the link. */
export async function stopPreview(
  checkout: string,
  name: string,
  deps: Pick<StartDeps, 'runner' | 'env' | 'log'>
): Promise<void> {
  if (!PREVIEW_NAME.test(name)) throw new PreviewError(`Not a preview name: ${name}`);
  if (!fs.existsSync(path.join(checkout, RECIPE_DIR, 'docker-compose.mvpfy.yml'))) return;
  await compose(
    { ...deps, engineHostname: '' },
    checkout,
    name,
    'down --volumes --remove-orphans',
    10 * 60_000
  );
}

/** What the pull request is told: where to try it, how to sign in, and for how long. */
export function previewComment(record: PreviewRecord, link: string, hours = 24): string {
  const login = record.demoLogin;
  return [
    `**Try this change:** ${link.replace(/\/$/, '')}${record.path === '/' ? '' : record.path}`,
    '',
    login
      ? `Sign in with the demo login: \`${login.email ?? ''}\` / \`${login.password ?? ''}\``
      : 'This product has no demo login.',
    '',
    `Started from \`${record.commit.slice(0, 12)}\` on \`${record.branch}\`. The link is taken down ` +
      `after ${hours} hours, data and all. It runs sample data only.`,
    '',
    '_Started by mvpfy._',
  ].join('\n');
}

/**
 * Every container on the tenant's engine, gone; images and volumes kept.
 *
 * Setting a product up starts its stack to check it, and an agent may leave
 * it running under any project name it chose. A link started after that met
 * a port the leftover stack still held. A tenant has one link at a time, so
 * before one starts, and after setup, nothing else on its engine is wanted.
 */
export async function clearEngine(
  deps: Pick<StartDeps, 'runner' | 'env' | 'log'>,
  cwd: string
): Promise<void> {
  const result = await deps.runner.run('docker ps -aq | xargs -r docker rm -f', {
    cwd,
    env: deps.env,
    timeoutMs: 5 * 60_000,
  });
  if (result.code !== 0) {
    throw new PreviewError(`Could not clear the tenant's engine: ${result.stderr.trim()}`);
  }
}
