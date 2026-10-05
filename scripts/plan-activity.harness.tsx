import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import PlanActivityPanel from '../src/components/PlanActivityPanel';
import type { RunState } from '../src/lib/useRuns';
import '../src/index.css';

// Synthetic streams only: never invokes an agent or reads a user's project.
function story(id: string): RunState {
  return {
    handle: {
      runId: id,
      projectId: 'fixture',
      kind: 'plan-story',
      planSlug: 'invoices',
      storyId: id,
    },
    log: `Implementing ${id}\n`,
    running: true,
    exitCode: null,
    prUrl: null,
  };
}
function Harness() {
  const [runs, setRuns] = useState<RunState[]>([]);
  const [stopped, setStopped] = useState('');
  return (
    <div className="flex h-screen flex-col">
      <main className="min-h-0 flex-1 overflow-auto p-6">
        <h1>Story board</h1>
        <button onClick={() => setRuns([story('S-1')])}>Start story</button>
        <button onClick={() => setRuns((prev) => [...prev, story('S-2')])}>
          Start another story
        </button>
        <button
          onClick={() =>
            setRuns((prev) =>
              prev.map((run) => ({ ...run, log: run.log + 'New streamed output\n' }))
            )
          }
        >
          Stream output
        </button>
        <button
          onClick={() =>
            setRuns((prev) => prev.map((run) => ({ ...run, running: false, exitCode: 0 })))
          }
        >
          Finish stories
        </button>
        <p data-testid="stopped">{stopped}</p>
        <div className="h-[1400px]">Scrollable board content</div>
      </main>
      <PlanActivityPanel runs={runs} onStop={setStopped} />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
