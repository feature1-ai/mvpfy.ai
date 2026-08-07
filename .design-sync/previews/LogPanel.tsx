import { LogPanel } from 'mvpfy';

const shipLog = [
  '$ claude -p --output-format stream-json < prompt.txt',
  '▸ claude session started (claude-fable-5)',
  'Loading Feature1 story INW-142 and its acceptance criteria.',
  '→ Bash: npm test',
  'All 48 tests passed.',
  '→ Bash: git add -A && git commit -m "INW-142: Invoice reminder cadence"',
  '→ Bash: gh pr create --fill',
  'https://github.com/inwisely/ar-backend/pull/87',
].join('\n');

const runningRun = {
  handle: { runId: 'ship-a1', kind: 'ship' as const, projectId: 'p1', storyId: 'INW-142' },
  log: shipLog.split('\n').slice(0, 5).join('\n') + '\n',
  running: true,
  exitCode: null,
  prUrl: null,
};

export const Running = () => <LogPanel run={runningRun} onStop={() => {}} />;

export const Succeeded = () => (
  <LogPanel
    run={{
      ...runningRun,
      log: shipLog + '\n✔ finished\n',
      running: false,
      exitCode: 0,
      prUrl: 'https://github.com/inwisely/ar-backend/pull/87',
    }}
    onStop={() => {}}
  />
);

export const Failed = () => (
  <LogPanel
    run={{
      handle: { runId: 'boot-b2', kind: 'bootstrap' as const, projectId: 'p1' },
      log: '$ docker compose -f docker-compose.mvpfy.yml up -d --build\nError: Cannot connect to the Docker daemon. Is the docker daemon running?\n',
      running: false,
      exitCode: 1,
      prUrl: null,
    }}
    onStop={() => {}}
  />
);

export const Idle = () => <LogPanel run={null} onStop={() => {}} />;
