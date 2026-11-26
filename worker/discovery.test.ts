import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverChecks } from './discovery';
import { ScriptedRunner } from './exec';
import { plainRedactor } from './redact';
import { Verifier } from './verify';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-discover-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function files(entries: Record<string, string>) {
  for (const [name, content] of Object.entries(entries)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
}
const summary = () =>
  discoverChecks(root).map((c) => `${c.name}${c.optional ? ' (optional)' : ''}`);

describe('finding checks nobody named', () => {
  it('keeps a JavaScript root as it was', () => {
    files({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }),
      'package-lock.json': '{}',
    });
    const [test, lint] = discoverChecks(root);
    expect(test).toMatchObject({
      id: 'discovered-test',
      name: 'npm test',
      command: 'npm test --silent',
    });
    expect(lint).toMatchObject({
      id: 'discovered-lint',
      name: 'npm run lint',
      command: 'npm run lint --silent',
      optional: true,
    });
  });

  it('runs a monorepo from its root when the root has a test script, and not again per package', () => {
    files({
      'package.json': JSON.stringify({ workspaces: ['apps/*'], scripts: { test: 'turbo test' } }),
      'pnpm-lock.yaml': '',
      'apps/web/package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
    });
    expect(summary()).toEqual(['pnpm test']);
  });

  it('runs every package through the workspace tool when the root has no test script', () => {
    files({
      'package.json': JSON.stringify({ private: true }),
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'pnpm-lock.yaml': '',
      'apps/web/package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
    });
    expect(discoverChecks(root)[0]?.command).toBe('corepack pnpm -r --if-present run test');
  });

  it('finds the parts of a repository kept in folders, each in its own language', () => {
    files({
      'web/package.json': JSON.stringify({ scripts: { test: 'jest' } }),
      'api/pyproject.toml': '[project]\nrequires-python = ">=3.11"\n[tool.pytest.ini_options]\n',
      'api/requirements.txt': 'fastapi\n',
      'services/billing/go.mod': 'module billing\n\ngo 1.22\n',
    });
    expect(summary()).toEqual([
      'pytest in api',
      'go test in services/billing',
      'go vet in services/billing (optional)',
      'npm test in web',
    ]);
    const pytest = discoverChecks(root).find((c) => c.name === 'pytest in api')!;
    expect(pytest.needsEngine).toBe(true);
    expect(pytest.command).toContain('python:3.11-slim');
    expect(pytest.command).toContain(`-w '${path.join(root, 'api')}'`);
    expect(pytest.command).toContain('pip install -q -r requirements.txt');
    expect(
      discoverChecks(root).find((c) => c.name === 'go test in services/billing')?.command
    ).toContain('golang:1.22');
  });

  it.each([
    [{ 'Cargo.toml': '[package]\nname="x"\n' }, 'cargo test', 'rust:1'],
    [{ 'pom.xml': '<project/>' }, 'mvn test', 'maven:3-eclipse-temurin-21'],
    [{ 'build.gradle.kts': '', gradlew: '' }, 'gradle test', './gradlew test'],
    [
      {
        Gemfile: "source 'https://rubygems.org'\n",
        '.ruby-version': '3.2.2\n',
        'spec/x_spec.rb': '',
      },
      'rspec',
      'ruby:3.2',
    ],
  ])('finds %j', (layout, name, inCommand) => {
    files(layout as Record<string, string>);
    const [check] = discoverChecks(root);
    expect(check?.name).toBe(name);
    expect(check?.command).toContain(inCommand);
  });

  it('does not invent a test run for a Python project with no tests', () => {
    files({ 'requirements.txt': 'flask\n', 'app.py': '' });
    expect(discoverChecks(root)).toEqual([]);
  });

  it("says a language's check could not run where there is no Docker engine, rather than skipping it", async () => {
    files({ 'go.mod': 'module x\n\ngo 1.22\n' });
    const withoutEngine = new Verifier(new ScriptedRunner(), plainRedactor, { PATH: '/bin' });
    const [result] = await withoutEngine.verifyRepository('r1', { worktrees: { r1: root } });
    expect(result).toMatchObject({ name: 'go test', outcome: 'unavailable' });
    expect(result?.reason).toMatch(/Docker engine/);

    const runner = new ScriptedRunner().when(/go test/, { code: 0 });
    const withEngine = new Verifier(runner, plainRedactor, {
      PATH: '/bin',
      DOCKER_HOST: 'tcp://engine:2375',
    });
    const [ran] = await withEngine.verifyRepository('r1', { worktrees: { r1: root } });
    expect(ran?.outcome).toBe('passed');
    expect(runner.calls[0]?.env?.DOCKER_HOST).toBe('tcp://engine:2375');
  });
});

describe('installing before the checks', () => {
  it('installs when node_modules is only an empty mount point', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-install-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest' } })
      );
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      fs.mkdirSync(path.join(dir, 'node_modules'));
      const runner = new ScriptedRunner().when(/npm ci/, { code: 0 }).when(/npm test/, { code: 0 });
      await new Verifier(runner, plainRedactor, { PATH: '/bin' }).verifyRepository('r1', {
        worktrees: { r1: dir },
      });
      expect(runner.calls.some((c) => /npm ci/.test(c.command))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
