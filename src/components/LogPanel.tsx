import { useEffect, useRef, useState } from 'react';
import { formatLog } from '../lib/logFormat';
import { parseUsage, shortCount, totalIn } from '../lib/usage';
import type { TurnUsage } from '../lib/usage';
import type { RunState } from '../lib/useRuns';

interface Props {
  run: RunState | null;
  onStop: (runId: string) => void;
  /** Tailwind height class for the panel; defaults to h-64. */
  heightClass?: string;
  /** Panel title override (defaults to the run kind). */
  title?: string;
}

export default function LogPanel({ run, onStop, heightClass = 'h-64', title }: Props) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [showTurns, setShowTurns] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.log, showRaw]);

  const display = run ? (showRaw ? run.log : formatLog(run.log)) : '';
  // Agent runs report what they consumed as they go, per turn. Every other
  // kind of run — docker, git, an installer — reports nothing, and a row of
  // zeroes beside those would be noise rather than information.
  const usage = run ? parseUsage(run.log) : null;
  const spent = usage && usage.turns.length > 0 ? usage : null;

  return (
    <div className={`flex ${heightClass} flex-col rounded-lg border border-slate-200 bg-slate-950`}>
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <div className="text-xs font-medium text-slate-300">
          {run ? (
            <>
              {title ?? run.handle.kind}
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
            'No saved runs yet'
          )}
        </div>
        <div className="flex items-center gap-2">
          {spent && (
            <button
              onClick={() => setShowTurns((v) => !v)}
              aria-expanded={showTurns}
              title={
                `${spent.turns.length} turn${spent.turns.length === 1 ? '' : 's'}\n` +
                `sent ${totalIn(spent.total).toLocaleString()} tokens ` +
                `(${spent.total.cacheRead.toLocaleString()} from cache)\n` +
                `wrote ${spent.total.output.toLocaleString()} tokens`
              }
              className={`rounded px-1 font-mono text-[10.5px] ${
                showTurns ? 'bg-slate-800 text-slate-200' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {spent.turns.length} turn{spent.turns.length === 1 ? '' : 's'} ·{' '}
              {shortCount(totalIn(spent.total))} in
              {/* Cache is usually most of it — a run reading 40k of context
                  it has already sent is not consuming 40k again, and the
                  unqualified number reads as though it were. */}
              {spent.total.cacheRead > 0 && ` (${shortCount(spent.total.cacheRead)} cached)`} ·{' '}
              {shortCount(spent.total.output)} out
            </button>
          )}
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
      {spent && showTurns && <TurnStrip turns={spent.turns} />}
      <pre
        ref={scrollRef}
        className="flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-slate-200"
      >
        {display ||
          (run?.running
            ? 'Waiting for output…'
            : run
              ? 'This run produced no readable output. Select Raw to inspect the original events.'
              : 'Completed runs will appear here. No task needs to be running to read saved logs.')}
      </pre>
    </div>
  );
}

/**
 * Every turn of a run, as one bar each.
 *
 * The total answers what a run consumed; this answers where it went — a long
 * run is rarely flat, and one turn that reads the whole repository dwarfing
 * twenty small ones is the shape worth seeing. Bars rather than a table
 * because the question is which one is tall, not what each number was, and the
 * numbers are on the bar anyway.
 */
function TurnStrip({ turns }: { turns: TurnUsage[] }) {
  // Scaled to the biggest turn rather than to an absolute ceiling: the
  // interesting thing is the proportion between them, and a fixed scale makes
  // a whole run of small turns look like a flat line.
  const peak = Math.max(...turns.map((t) => totalIn(t) + t.output), 1);
  return (
    <div className="flex items-end gap-[2px] overflow-x-auto border-b border-slate-800 px-3 py-2">
      {turns.map((t, i) => {
        const size = totalIn(t) + t.output;
        return (
          <div
            key={i}
            title={
              `turn ${i + 1} of ${turns.length}\n` +
              `sent ${totalIn(t).toLocaleString()}` +
              (t.cacheRead > 0 ? ` (${t.cacheRead.toLocaleString()} cached)` : '') +
              `\nwrote ${t.output.toLocaleString()}`
            }
            className="flex h-10 w-[7px] shrink-0 cursor-default flex-col justify-end"
          >
            {/* Written tokens on top of sent, so a turn that read a great deal
                and wrote little reads differently from one that did the
                reverse — they cost differently and mean different things. */}
            <div
              className="w-full rounded-t-[1px] bg-emerald-400"
              style={{ height: `${Math.max((t.output / peak) * 100, size > 0 ? 2 : 0)}%` }}
            />
            <div
              className="w-full bg-slate-600"
              style={{ height: `${(totalIn(t) / peak) * 100}%` }}
            />
          </div>
        );
      })}
      <span className="ml-2 shrink-0 self-center font-mono text-[10px] text-slate-500">
        each bar one turn · grey sent, green written
      </span>
    </div>
  );
}
