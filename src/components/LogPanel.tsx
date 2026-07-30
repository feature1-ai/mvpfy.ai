import { useEffect, useRef } from 'react';
import { RunState } from '../lib/useRuns';

interface Props {
  run: RunState | null;
  onStop: (runId: string) => void;
}

export default function LogPanel({ run, onStop }: Props) {
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.log]);

  return (
    <div className="flex h-64 flex-col rounded-lg border border-slate-200 bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <div className="text-xs font-medium text-slate-300">
          {run ? (
            <>
              {run.handle.kind}
              {run.handle.storyId ? ` · ${run.handle.storyId}` : ''}
              {run.running ? (
                <span className="ml-2 text-emerald-400">running</span>
              ) : (
                <span className={`ml-2 ${run.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  exited ({run.exitCode ?? 'killed'})
                </span>
              )}
            </>
          ) : (
            'No run yet'
          )}
        </div>
        {run?.running && (
          <button
            onClick={() => onStop(run.handle.runId)}
            className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500"
          >
            Stop
          </button>
        )}
      </div>
      <pre
        ref={scrollRef}
        className="flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-slate-200"
      >
        {run?.log || 'Agent output will stream here.'}
      </pre>
    </div>
  );
}
