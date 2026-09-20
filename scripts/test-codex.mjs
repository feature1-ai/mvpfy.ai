// Opt-in live test: uses the user's Codex login and model allowance.
// Run after build:electron, or use npm run test:codex.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runAgent } from '../dist-electron/electron/services/agents.js';
import { setLinkedRoots } from '../dist-electron/electron/paths.js';
import { setRunEventSink, stopRun } from '../dist-electron/electron/services/runs.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-codex-smoke-'));
const runId = `codex-smoke-${Date.now()}`;
const logFile = path.join(workspace, 'run.jsonl');
fs.writeFileSync(logFile, '', { mode: 0o600 });
fs.writeFileSync(path.join(workspace, 'math.cjs'), 'exports.add = (a, b) => a - b;\n');
const tests = `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { add } = require('./math.cjs');
test('adds positive and negative numbers', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-4, 2), -2);
  assert.equal(add(0, 7), 7);
});
`;
fs.writeFileSync(path.join(workspace, 'math.test.cjs'), tests);
setLinkedRoots([workspace]);
let stdout = '';
let timedOut = false;
let completed = false;
let timeout;
let progress;

function finish(code) {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  clearInterval(progress);
  try {
    if (timedOut) throw new Error('Codex exceeded the two-minute timeout.');
    if (code !== 0) throw new Error(`Codex exited with ${code ?? 'no exit code'}.`);
    const events = stdout.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    if (!events.some((event) => event.type === 'turn.completed')) {
      throw new Error('No successful Codex turn event was received.');
    }
    if (
      !events.some(
        (event) =>
          event.item?.type === 'agent_message' && event.item.text?.includes('MVPFY_CODEX_SMOKE_OK')
      )
    ) {
      throw new Error('The requested completion marker was not received.');
    }
    if (fs.readFileSync(path.join(workspace, 'math.test.cjs'), 'utf8') !== tests) {
      throw new Error('The agent changed the test instead of only fixing the implementation.');
    }
    execFileSync(process.execPath, ['--test', 'math.test.cjs'], { cwd: workspace, timeout: 10000 });
    console.log('PASS: mvpfy launched Codex, received JSON events, and verified its code change.');
    console.log(
      'This does not test Docker bootstrap, Feature1 MCP, the Electron UI, or PR creation.'
    );
  } catch (error) {
    process.exitCode = 1;
    console.error(`FAIL: ${error.message}`);
  }
  console.log(`Fixture and diagnostic log: ${workspace}`);
}

setRunEventSink({
  output(event) {
    if (event.runId !== runId) return;
    fs.appendFileSync(logFile, event.chunk);
    if (event.stream === 'stdout') stdout += event.chunk;
  },
  exit(event) {
    if (event.runId === runId) finish(event.code);
  },
});

console.log(`Testing the real mvpfy Codex runner in ${workspace}`);
console.log('Uses your existing Codex authentication and configured model.');
progress = setInterval(() => console.log('Waiting for Codex…'), 15000);
timeout = setTimeout(() => {
  timedOut = true;
  stopRun(runId);
}, 120000);
try {
  runAgent({
    runId,
    agent: 'codex',
    repoPath: workspace,
    ...(process.env.MVPFY_CODEX_TEST_MODEL ? { model: process.env.MVPFY_CODEX_TEST_MODEL } : {}),
    promptText:
      'This is a tiny integration test. Work only in the current directory. ' +
      'Read math.cjs and math.test.cjs. Fix add in math.cjs so the existing tests pass. ' +
      'Do not change the tests. Run node --test math.test.cjs. Do not use git, MCP, ' +
      'external services, or install anything. Finish with MVPFY_CODEX_SMOKE_OK only after tests pass.',
  });
} catch (error) {
  console.error(error.message);
  finish(1);
}
