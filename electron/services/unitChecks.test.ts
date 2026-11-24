import { describe, expect, it } from 'vitest';
import { UnitCheckSpec } from '../../shared/agentUnits';
import { CheckAccess, failedChecks } from './unitChecks';
import { ShellResult } from './shell';

/** A workspace that exists only in the test, and a Docker that answers from a script. */
function workspace(
  files: Record<string, string>,
  docker: Partial<ShellResult> = { status: 0 }
): CheckAccess & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    read: (relativePath) => files[relativePath] ?? null,
    run: async (command) => {
      commands.push(command);
      return { status: 0, stdout: '', stderr: '', ...docker };
    },
  };
}

const check = (spec: UnitCheckSpec, access: CheckAccess) => failedChecks([spec], access);

describe('files', () => {
  it('holds when every file is there and has something in it', async () => {
    const access = workspace({ 'a.yml': 'x', '.env': 'A=1' });
    expect(await check({ kind: 'files', paths: ['a.yml', '.env'] }, access)).toEqual([]);
  });

  it('names what is missing, and counts an empty file as missing', async () => {
    const access = workspace({ 'a.yml': 'x', '.env': '  \n' });
    const [failure] = await check({ kind: 'files', paths: ['a.yml', '.env', 'b.md'] }, access);
    expect(failure).toContain('.env, b.md');
    expect(failure).not.toContain('a.yml');
  });
});

describe('contains', () => {
  it('holds when every marker is in the file', async () => {
    const access = workspace({ 'AGENTS.md': 'x <!-- mvpfy:start --> y <!-- mvpfy:end --> z' });
    expect(
      await check(
        {
          kind: 'contains',
          path: 'AGENTS.md',
          needles: ['<!-- mvpfy:start', '<!-- mvpfy:end -->'],
        },
        access
      )
    ).toEqual([]);
  });

  it('says which marker is absent, and says so when the file is', async () => {
    const spec: UnitCheckSpec = { kind: 'contains', path: 'CLAUDE.md', needles: ['@AGENTS.md'] };
    expect((await check(spec, workspace({ 'CLAUDE.md': '# rules' })))[0]).toContain('@AGENTS.md');
    expect((await check(spec, workspace({})))[0]).toContain('does not exist');
  });
});

describe('compose-config', () => {
  it('asks Docker about the file where this kind of project keeps it', async () => {
    const managed = workspace({});
    await check({ kind: 'compose-config', linked: false }, managed);
    expect(managed.commands).toEqual(['docker compose -f docker-compose.mvpfy.yml config -q']);

    const linked = workspace({});
    await check({ kind: 'compose-config', linked: true }, linked);
    expect(linked.commands[0]).toContain(
      '-f .mvpfy/docker-compose.mvpfy.yml --project-directory .'
    );
  });

  it('hands back what Docker said when it refuses the stack', async () => {
    const access = workspace({}, { status: 15, stderr: 'services.app.ports must be a list' });
    const [failure] = await check({ kind: 'compose-config', linked: false }, access);
    expect(failure).toContain('exited with code 15');
    expect(failure).toContain('services.app.ports must be a list');
  });

  it('does not fail a step because Docker could not be asked', async () => {
    for (const docker of [
      { status: 127, stderr: 'sh: docker: command not found' },
      { status: null, stderr: '' },
      { status: 1, stderr: "docker: 'compose' is not a docker command." },
    ]) {
      expect(await check({ kind: 'compose-config', linked: false }, workspace({}, docker))).toEqual(
        []
      );
    }
  });
});

describe('manifest-ports', () => {
  const spec: UnitCheckSpec = { kind: 'manifest-ports', path: 'mvpfy.yml' };

  it('holds when the two places agree', async () => {
    const access = workspace({ 'mvpfy.yml': 'host_port: 3001\nurl: http://localhost:3001\n' });
    expect(await check(spec, access)).toEqual([]);
  });

  it('holds when only one of them is written', async () => {
    expect(await check(spec, workspace({ 'mvpfy.yml': 'host_port: 3001\n' }))).toEqual([]);
  });

  it('catches the app that would open on a port nothing publishes', async () => {
    const access = workspace({ 'mvpfy.yml': 'host_port: 3001\nurl: http://localhost:3000\n' });
    const [failure] = await check(spec, access);
    expect(failure).toContain('3001');
    expect(failure).toContain('3000');
  });

  it('refuses a manifest that names no port at all', async () => {
    const [failure] = await check(spec, workspace({ 'mvpfy.yml': 'name: shop\n' }));
    expect(failure).toContain('does not say which port');
  });
});

describe('demo-login', () => {
  const spec: UnitCheckSpec = { kind: 'demo-login', manifest: 'mvpfy.yml', env: '.env' };
  const env = 'MVPFY_DEMO_EMAIL=demo@acme.test\nMVPFY_DEMO_PASSWORD="let-me-in"\n';

  it('holds when the login shown is the one the seed uses', async () => {
    const manifest = 'demo_login:\n  email: demo@acme.test\n  password: let-me-in\n';
    expect(await check(spec, workspace({ '.env': env, 'mvpfy.yml': manifest }))).toEqual([]);
  });

  it('catches a login on screen that the seed never created', async () => {
    const manifest = 'demo_login:\n  email: admin@example.com\n  password: let-me-in\n';
    const [failure] = await check(spec, workspace({ '.env': env, 'mvpfy.yml': manifest }));
    expect(failure).toContain('MVPFY_DEMO_EMAIL');
    expect(failure).not.toContain('MVPFY_DEMO_PASSWORD');
  });

  it('catches an env that promises a demo account the manifest never mentions', async () => {
    const [failure] = await check(spec, workspace({ '.env': env, 'mvpfy.yml': 'host_port: 1\n' }));
    expect(failure).toContain('MVPFY_DEMO_EMAIL and MVPFY_DEMO_PASSWORD');
  });

  it('says nothing about a product with no demo account', async () => {
    expect(await check(spec, workspace({ '.env': 'PORT=3000\n', 'mvpfy.yml': 'x: 1\n' }))).toEqual(
      []
    );
    expect(await check(spec, workspace({ 'mvpfy.yml': 'x: 1\n' }))).toEqual([]);
  });

  it('does not insist the account is in this env file when the manifest has one', async () => {
    // A component's own env file may define it; that is where the rules put it.
    const manifest = 'demo_login:\n  email: demo@acme.test\n';
    expect(await check(spec, workspace({ '.env': 'PORT=1\n', 'mvpfy.yml': manifest }))).toEqual([]);
  });
});

describe('failedChecks', () => {
  it('reports every failure, in order', async () => {
    const failures = await failedChecks(
      [
        { kind: 'files', paths: ['a'] },
        { kind: 'files', paths: ['b'] },
        { kind: 'manifest-ports', path: 'mvpfy.yml' },
      ],
      workspace({ b: 'x' })
    );
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('a');
    expect(failures[1]).toContain('mvpfy.yml');
  });

  it('treats a check that could not be made as not having failed', async () => {
    const broken: CheckAccess = {
      read: () => {
        throw new Error('disk gone');
      },
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    };
    expect(await failedChecks([{ kind: 'files', paths: ['a'] }], broken)).toEqual([]);
  });
});
