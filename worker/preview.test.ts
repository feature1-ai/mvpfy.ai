import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { commandFrom } from './config';
import { engineHostFrom, withEngine } from './engineHost';
import { ScriptedRunner } from './exec';
import { FakeAgent } from './harness';
import { applyRecipe, keepRecipe, prepareCheckout } from './prepare';
import {
  PreviewError,
  demoLoginOf,
  previewComment,
  entryOf,
  seedCommandOf,
  startPreview,
  stopPreview,
} from './preview';

const TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'prompts', 'bootstrap-runtime.txt'),
  'utf8'
);

const MANIFEST = `name: ThankYouDoctor
main_service: app
host_port: 4000
url: http://localhost:4000/en
services:
  - name: app
    port: 4000
migrations: []
seed_command: "docker compose -f .mvpfy/docker-compose.mvpfy.yml --project-directory . exec -T app node scripts/seed.mjs"
demo_login:
  url: http://localhost:4000/login
  email: demo@thankyou.test
  password: "demo-pass-1"
`;

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-preview-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(dir: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

describe('the tenant engine', () => {
  it('reaches the sandbox as DOCKER_HOST, and only when there is one', () => {
    const engine = engineHostFrom({ MVPFY_ENGINE_HOST: 'tcp://mvpfy-engine-acme:2375' });
    expect(engine).toEqual({
      dockerHost: 'tcp://mvpfy-engine-acme:2375',
      hostname: 'mvpfy-engine-acme',
    });
    expect(withEngine({ PATH: '/bin' }, engine)).toEqual({
      PATH: '/bin',
      DOCKER_HOST: 'tcp://mvpfy-engine-acme:2375',
    });
    expect(withEngine({ PATH: '/bin' }, null)).toEqual({ PATH: '/bin' });
    expect(engineHostFrom({})).toBeNull();
  });

  it.each(['unix:///var/run/docker.sock', 'http://engine:2375', 'tcp://engine', 'nonsense'])(
    'refuses %j',
    (value) => {
      expect(() => engineHostFrom({ MVPFY_ENGINE_HOST: value })).toThrow(/MVPFY_ENGINE_HOST/);
    }
  );
});

describe('preparing a product', () => {
  /** An agent that writes, on each setup step, the files that step is checked for. */
  function setupAgent(checkout: string, leaveOut: string[] = []) {
    const agent = new FakeAgent();
    const byStep: Record<number, Record<string, string>> = {
      0: { '.mvpfy/docker-compose.mvpfy.yml': 'services:\n  app:\n    image: node\n' },
      1: { '.mvpfy/.env.mvpfy.example': 'A=1\n', '.mvpfy/.env': 'A=1\n' },
      2: { '.mvpfy/mvpfy.yml': MANIFEST },
      5: {
        '.mvpfy/mvpfy-summary.md': 'Summary\n',
        '.mvpfy/mvpfy-run.md': 'Run\n',
        'AGENTS.md': '<!-- mvpfy:start -->\nnotes\n<!-- mvpfy:end -->\n',
        'CLAUDE.md': '@AGENTS.md\n',
      },
    };
    let step = -1;
    agent.onRun = () => {
      const prompt = agent.runs.at(-1)?.prompt ?? '';
      const match = prompt.match(/STEP (\d) OF 6/);
      step = match ? Number(match[1]) - 1 : step;
      const files = { ...(byStep[step] ?? {}) };
      for (const name of leaveOut) delete files[name];
      write(checkout, files);
    };
    return agent;
  }

  function deps(agent: FakeAgent, checks = new ScriptedRunner()) {
    return {
      agent,
      checks,
      checkEnv: { DOCKER_HOST: 'tcp://engine:2375' },
      agentKind: 'claude' as const,
      template: TEMPLATE,
      log: () => {},
    };
  }

  it("runs the desktop's six steps, checked as the desktop checks them", async () => {
    const checkout = path.join(root, 'checkout');
    fs.mkdirSync(checkout);
    const checks = new ScriptedRunner().when(/config -q/, { code: 0 });
    const agent = setupAgent(checkout);
    const progress = path.join(root, 'progress.json');
    const outcome = await prepareCheckout(
      checkout,
      path.join(root, 'agent'),
      progress,
      deps(agent, checks)
    );
    expect(outcome).toEqual({ kind: 'done' });
    expect(agent.runs).toHaveLength(6);
    // The setup instructions are filled in for this checkout, as a linked project.
    expect(agent.runs[0]?.prompt).toContain(checkout);
    expect(agent.runs[0]?.prompt).toContain('.mvpfy/');
    // Docker's check of the stack runs in the sandbox, against the tenant engine.
    const config = checks.calls.find((call) => call.command.includes('config -q'));
    expect(config?.command).toContain('.mvpfy/docker-compose.mvpfy.yml');
    expect(config?.env?.DOCKER_HOST).toBe('tcp://engine:2375');
  });

  it('sends a step back with what its check found, and gives up after three tries', async () => {
    const checkout = path.join(root, 'checkout');
    fs.mkdirSync(checkout);
    const agent = setupAgent(checkout, ['.mvpfy/mvpfy.yml']);
    const outcome = await prepareCheckout(
      checkout,
      path.join(root, 'agent'),
      path.join(root, 'progress.json'),
      deps(agent, new ScriptedRunner().when(/config -q/, { code: 0 }))
    );
    expect(outcome).toMatchObject({ kind: 'failed', step: 'Tell mvpfy where your app is' });
    expect(agent.runs[3]?.prompt).toContain('mvpfy.yml');
    expect(agent.runs[3]?.prompt).toMatch(/attempt 2 of 3/);
    // Running it again carries on from the step that did not finish.
    const again = setupAgent(checkout);
    await prepareCheckout(
      checkout,
      path.join(root, 'agent'),
      path.join(root, 'progress.json'),
      deps(again, new ScriptedRunner().when(/config -q/, { code: 0 }))
    );
    expect(again.runs[0]?.prompt).toMatch(/STEP 3 OF 6/);
  });

  it('stops to ask when the agent has a question', async () => {
    const checkout = path.join(root, 'checkout');
    fs.mkdirSync(checkout);
    const agent = new FakeAgent();
    agent.outcomes = [{ questions: ['Which payment provider?'] }];
    const outcome = await prepareCheckout(
      checkout,
      path.join(root, 'agent'),
      path.join(root, 'progress.json'),
      deps(agent)
    );
    expect(outcome).toEqual({ kind: 'questions', questions: ['Which payment provider?'] });
  });

  it('keeps the recipe, and lays it over another checkout', () => {
    const checkout = path.join(root, 'checkout');
    write(checkout, {
      '.mvpfy/mvpfy.yml': MANIFEST,
      '.mvpfy/docker-compose.mvpfy.yml': 'services: {}\n',
      '.mvpfy/mvpfy-questions.md': '1. stale\n',
    });
    const recipe = path.join(root, 'recipes', 'r1');
    keepRecipe(checkout, recipe);
    expect(fs.existsSync(path.join(recipe, 'mvpfy.yml'))).toBe(true);
    expect(fs.existsSync(path.join(recipe, 'mvpfy-questions.md'))).toBe(false);
    const branch = path.join(root, 'branch');
    write(branch, { '.mvpfy/old.txt': 'gone\n', 'app.js': 'x\n' });
    applyRecipe(recipe, branch);
    expect(fs.readFileSync(path.join(branch, '.mvpfy', 'mvpfy.yml'), 'utf8')).toBe(MANIFEST);
    expect(fs.existsSync(path.join(branch, '.mvpfy', 'old.txt'))).toBe(false);
    expect(() => applyRecipe(path.join(root, 'nothing'), branch)).toThrow(/prepare/);
  });
});

describe('reading the recipe', () => {
  it('finds the port, the path, the seed and the demo login', () => {
    expect(entryOf(MANIFEST)).toEqual({ port: 4000, path: '/en' });
    expect(seedCommandOf(MANIFEST)).toContain('scripts/seed.mjs');
    expect(demoLoginOf(MANIFEST)).toEqual({ email: 'demo@thankyou.test', password: 'demo-pass-1' });
  });

  it('copes with what is not there', () => {
    expect(() => entryOf('name: x\n')).toThrow(PreviewError);
    expect(entryOf('host_port: 3000\n')).toEqual({ port: 3000, path: '/' });
    expect(seedCommandOf('name: x\n')).toBeNull();
    expect(demoLoginOf('name: x\n')).toBeNull();
    expect(demoLoginOf('demo_login:\n  username: admin\n  password: pw\nnext: 1\n')).toEqual({
      email: 'admin',
      password: 'pw',
    });
  });
});

describe('starting and stopping a test link', () => {
  function prepared() {
    const checkout = path.join(root, 'previews', 'pabcdefghijkl', 'repo');
    write(checkout, {
      '.mvpfy/mvpfy.yml': MANIFEST,
      '.mvpfy/docker-compose.mvpfy.yml': 'services: {}\n',
    });
    return checkout;
  }
  const meta = { name: 'pabcdefghijkl', branch: 'mvpfy/x', commit: 'a'.repeat(40) };

  it('brings the stack up as its own project on the engine, waits for it, then seeds', async () => {
    const checkout = prepared();
    const runner = new ScriptedRunner().when(/up -d/, { code: 0 }).when(/seed\.mjs/, { code: 0 });
    const asked: string[] = [];
    let tries = 0;
    const fetchImpl = (async (url: string) => {
      asked.push(String(url));
      return new Response('', { status: ++tries < 3 ? 502 : 200 });
    }) as unknown as typeof fetch;
    const record = await startPreview(checkout, meta, {
      runner,
      env: { DOCKER_HOST: 'tcp://mvpfy-engine-acme:2375' },
      engineHostname: 'mvpfy-engine-acme',
      fetchImpl,
      log: () => {},
      sleep: async () => {},
    });
    expect(record).toMatchObject({
      name: 'pabcdefghijkl',
      port: 4000,
      path: '/en',
      demoLogin: { email: 'demo@thankyou.test', password: 'demo-pass-1' },
    });
    expect(asked.at(-1)).toBe('http://mvpfy-engine-acme:4000/en');
    const [up, seed] = runner.calls;
    expect(up?.command).toBe(
      'docker compose -f .mvpfy/docker-compose.mvpfy.yml --project-directory . up -d --build --remove-orphans'
    );
    // The project name in the environment, so the recorded seed reaches the same stack.
    expect(up?.env?.COMPOSE_PROJECT_NAME).toBe('pabcdefghijkl');
    expect(seed?.env?.COMPOSE_PROJECT_NAME).toBe('pabcdefghijkl');
    expect(seed?.env?.DOCKER_HOST).toBe('tcp://mvpfy-engine-acme:2375');
  });

  it('says so when the containers start and nothing answers', async () => {
    const checkout = prepared();
    const runner = new ScriptedRunner().when(/up -d/, { code: 0 });
    const fetchImpl = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(
      startPreview(checkout, meta, {
        runner,
        env: {},
        engineHostname: 'e',
        fetchImpl,
        log: () => {},
        readyWithinMs: 1,
        sleep: async () => {},
      })
    ).rejects.toThrow(/nothing answered on port 4000/);
  });

  it('reports a stack that would not start, with the end of what compose said', async () => {
    const checkout = prepared();
    const runner = new ScriptedRunner().when(/up -d/, {
      code: 1,
      stderr: 'port is already allocated',
    });
    await expect(
      startPreview(checkout, meta, { runner, env: {}, engineHostname: 'e', log: () => {} })
    ).rejects.toThrow(/port is already allocated/);
  });

  it('takes the stack down with its data, and refuses a name it did not make', async () => {
    const checkout = prepared();
    const runner = new ScriptedRunner().when(/down/, { code: 0 });
    await stopPreview(checkout, 'pabcdefghijkl', { runner, env: {}, log: () => {} });
    expect(runner.calls[0]?.command).toContain('down --volumes --remove-orphans');
    expect(runner.calls[0]?.env?.COMPOSE_PROJECT_NAME).toBe('pabcdefghijkl');
    await expect(
      stopPreview(checkout, '../etc', { runner, env: {}, log: () => {} })
    ).rejects.toThrow(PreviewError);
  });

  it('is asked for by the worker with a branch and a name', () => {
    expect(commandFrom(['n', 'i', 'prepare'])).toEqual({ name: 'prepare' });
    expect(commandFrom(['n', 'i', 'preview', 'mvpfy/x', 'pabcdefghijkl'])).toEqual({
      name: 'preview',
      branch: 'mvpfy/x',
      preview: 'pabcdefghijkl',
    });
    expect(commandFrom(['n', 'i', 'preview-stop', 'pabcdefghijkl'])).toEqual({
      name: 'preview-stop',
      preview: 'pabcdefghijkl',
    });
    expect(() => commandFrom(['n', 'i', 'preview', 'mvpfy/x'])).toThrow(/Unrecognised/);
  });
});

describe('the comment on the pull request', () => {
  it("gives the link at the product's own path, the login, and when it goes away", () => {
    const body = previewComment(
      {
        name: 'pabcdefghijkl',
        branch: 'mvpfy/x',
        commit: 'abcdef1234567890',
        port: 4000,
        path: '/en',
        demoLogin: { email: 'demo@t.test', password: 'pw' },
        startedAt: '2026-11-25T00:00:00.000Z',
      },
      'https://pabcdefghijkl.mvpfy.ai/'
    );
    expect(body).toContain('https://pabcdefghijkl.mvpfy.ai/en');
    expect(body).toContain('`demo@t.test` / `pw`');
    expect(body).toContain('after 24 hours');
  });

  it('is asked for with a pull request, a preview and its link', () => {
    expect(
      commandFrom([
        'n',
        'i',
        'comment',
        'https://github.com/a/b/pull/3',
        'pabcdefghijkl',
        'https://pabcdefghijkl.mvpfy.ai',
      ])
    ).toMatchObject({ name: 'comment', pullRequest: 'https://github.com/a/b/pull/3' });
  });
});
