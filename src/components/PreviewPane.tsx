import { ReactNode, useRef, useState } from 'react';

interface Props {
  appUrl: string;
  appHealthy: boolean;
  ideUrl: string | null;
  ideHealthy: boolean;
  ideStarting: boolean;
  busy: boolean;
  onStartIde: () => void;
  onStopIde: () => void;
}

type Tab = 'preview' | 'ide';

/** Embedded Chromium panes: live app preview and the code-server IDE. */
export default function PreviewPane({
  appUrl,
  appHealthy,
  ideUrl,
  ideHealthy,
  ideStarting,
  busy,
  onStartIde,
  onStopIde,
}: Props) {
  const [tab, setTab] = useState<Tab>('preview');
  // Bumping the key remounts the webview — the simplest reliable "reload".
  const [reloadKey, setReloadKey] = useState(0);
  const activeUrl = tab === 'preview' ? (appHealthy ? appUrl : null) : ideHealthy ? ideUrl : null;
  const webviewRef = useRef<HTMLElement>(null);

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
        <div className="flex gap-1">
          {(['preview', 'ide'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                tab === t ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {t === 'preview' ? 'App preview' : 'IDE (VS Code)'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {activeUrl && (
            <>
              <button
                onClick={() => setReloadKey((k) => k + 1)}
                className="text-xs font-medium text-blue-600 hover:underline"
              >
                Reload
              </button>
              <button
                onClick={() => void window.mvpfy.openExternal(activeUrl)}
                className="text-xs font-medium text-blue-600 hover:underline"
              >
                Open in browser ↗
              </button>
            </>
          )}
          {tab === 'ide' && ideUrl && (
            <button
              onClick={onStopIde}
              disabled={busy}
              className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              Stop IDE
            </button>
          )}
        </div>
      </div>

      <div className="h-[520px]">
        {activeUrl ? (
          <webview
            key={`${tab}-${activeUrl}-${reloadKey}`}
            ref={webviewRef}
            src={activeUrl}
            partition="persist:mvpfy-embedded"
            className="block h-full w-full"
          />
        ) : tab === 'preview' ? (
          <Placeholder>
            {appHealthy
              ? 'Loading…'
              : 'Start the environment — the running app will appear here.'}
          </Placeholder>
        ) : ideUrl || ideStarting ? (
          <Placeholder>Starting VS Code (code-server)… first launch downloads the image.</Placeholder>
        ) : (
          <Placeholder>
            <button
              onClick={onStartIde}
              disabled={busy}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              Launch VS Code IDE
            </button>
            <p className="mt-2 text-xs text-slate-400">
              Runs open-source code-server in Docker with this project mounted. First launch
              downloads the image (~300 MB).
            </p>
          </Placeholder>
        )}
      </div>
    </section>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center text-sm text-slate-400">
      {children}
    </div>
  );
}
