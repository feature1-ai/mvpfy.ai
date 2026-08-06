import { useEffect, useRef, useState } from 'react';
import { formatLog } from '../lib/logFormat';
import { RunState } from '../lib/useRuns';

interface Props {
  run: RunState | null;
  onStop: (runId: string) => void;
}

export default function LogPanel({ run, onStop }: Props) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.log, showRaw]);

  const display = run ? (showRaw ? run.log : formatLog(run.log)) : '';

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
                <span
                  className={`ml-2 ${run.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}`}
                >
                  exited ({run.exitCode ?? 'killed'})
                </span>
              )}
            </>
          ) : (
            'No run yet'
          )}
        </div>
        <div className="flex items-center gap-2">
          {run && (
            <button
              onClick={() => setShowRaw((v) => !v)}
              className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-slate-300 hover:bg-brand"
            >
              {showRaw ? 'Pretty' : 'Raw'}
            </button>
          )}
          {run?.running && (
            <button
              onClick={() => onStop(run.handle.runId)}
              className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500"
            >
              Stop
            </button>
          )}
        </div>
      </div>
      <pre
        ref={scrollRef}
        className="flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-slate-200"
      >
        {display || 'Agent output will stream here.'}
      </pre>
    </div>
  );
}
