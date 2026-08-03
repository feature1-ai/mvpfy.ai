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
  /** Rendered as the first tab: project info, environment, stories, logs. */
  overview: ReactNode;
}

interface TabMeta {
  title?: string;
  favicon?: string;
}

interface BrowserTab {
  id: string;
  url: string | null;
  fallback: string;
  closable: boolean;
}

/**
 * Browser-like tab strip over persistent Electron <webview> panes: the app
 * preview, the code-server IDE, and any extra local URLs the PM opens.
 * Inactive webviews stay mounted (visibility toggle) so switching is instant.
 */
export default function PreviewPane({
  appUrl,
  appHealthy,
  ideUrl,
  ideHealthy,
  ideStarting,
  busy,
  onStartIde,
  onStopIde,
  overview,
}: Props) {
  const [activeId, setActiveId] = useState('overview');
  const [meta, setMeta] = useState<Record<string, TabMeta>>({});
  const [customTabs, setCustomTabs] = useState<Array<{ id: string; url: string }>>([]);
  const [adding, setAdding] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webviews = useRef(new Map<string, any>());
  const listened = useRef(new Set<string>());

  const tabs: BrowserTab[] = [
    { id: 'overview', url: null, fallback: 'Overview', closable: false },
    { id: 'app', url: appHealthy ? appUrl : null, fallback: 'App preview', closable: false },
    { id: 'ide', url: ideHealthy ? ideUrl : null, fallback: 'IDE (VS Code)', closable: false },
    ...customTabs.map((t) => ({
      id: t.id,
      url: t.url,
      fallback: t.url.replace(/^https?:\/\//, ''),
      closable: true,
    })),
  ];
  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const refFor = (id: string) => (el: HTMLElement | null) => {
    if (!el) {
      webviews.current.delete(id);
      listened.current.delete(id);
      return;
    }
    webviews.current.set(id, el);
    if (!listened.current.has(id)) {
      listened.current.add(id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      el.addEventListener('page-title-updated', (e: any) => {
        setMeta((m) => ({ ...m, [id]: { ...m[id], title: e.title } }));
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      el.addEventListener('page-favicon-updated', (e: any) => {
        setMeta((m) => ({ ...m, [id]: { ...m[id], favicon: e.favicons?.[0] } }));
      });
    }
  };

  function addCustomTab() {
    const url = newUrl.trim();
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(url)) return;
    const id = `custom-${Date.now()}`;
    setCustomTabs((prev) => [...prev, { id, url }]);
    setActiveId(id);
    setNewUrl('');
    setAdding(false);
  }

  function closeTab(id: string) {
    setCustomTabs((prev) => prev.filter((t) => t.id !== id));
    setMeta((m) => {
      const { [id]: _gone, ...rest } = m;
      return rest;
    });
    if (activeId === id) setActiveId('overview');
  }

  function reloadActive() {
    const el = webviews.current.get(activeTab.id);
    el?.reload?.();
  }

  return (
    <section className="flex h-full flex-col overflow-hidden bg-white">
      <div className="flex shrink-0 items-end justify-between gap-2 border-b border-slate-200 bg-slate-100 px-2 pt-1.5">
        <div className="flex min-w-0 items-end gap-0.5">
          {tabs.map((t) => {
            const m = meta[t.id] ?? {};
            const isActive = t.id === activeId;
            return (
              <div
                key={t.id}
                className={`group flex max-w-[13rem] cursor-pointer items-center gap-1.5 rounded-t-lg px-3 py-1.5 text-xs ${
                  isActive
                    ? 'bg-white font-medium text-slate-800 shadow-sm'
                    : 'text-slate-500 hover:bg-slate-200'
                }`}
                onClick={() => setActiveId(t.id)}
              >
                {t.id === 'overview' ? (
                  <span className="shrink-0 text-[13px] leading-none text-slate-400">⌂</span>
                ) : m.favicon ? (
                  <img
                    src={m.favicon}
                    alt=""
                    className="h-3.5 w-3.5 shrink-0"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      t.url ? 'bg-emerald-400' : 'bg-slate-300'
                    }`}
                  />
                )}
                <span className="truncate">{m.title || t.fallback}</span>
                {t.closable && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                    className="ml-0.5 hidden rounded-full px-1 text-slate-400 hover:bg-slate-300 hover:text-slate-700 group-hover:block"
                    title="Close tab"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          {adding ? (
            <div className="flex items-center gap-1 px-2 pb-1">
              <input
                autoFocus
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addCustomTab();
                  if (e.key === 'Escape') setAdding(false);
                }}
                placeholder="http://localhost:4103"
                className="w-44 rounded border border-slate-300 px-2 py-0.5 text-xs focus:border-slate-500 focus:outline-none"
              />
              <button
                onClick={addCustomTab}
                className="text-xs font-medium text-blue-600 hover:underline"
              >
                Open
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="mb-1 rounded-full px-2 py-0.5 text-sm text-slate-400 hover:bg-slate-200 hover:text-slate-600"
              title="Open a local URL in a new tab (e.g. MailHog)"
            >
              +
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 pb-1.5">
          {activeTab.url && (
            <>
              <button
                onClick={reloadActive}
                className="text-xs font-medium text-blue-600 hover:underline"
              >
                Reload
              </button>
              <button
                onClick={() => void window.mvpfy.openExternal(activeTab.url!)}
                className="text-xs font-medium text-blue-600 hover:underline"
              >
                Open in browser ↗
              </button>
            </>
          )}
          {activeTab.id === 'ide' && ideUrl && (
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

      <div className="relative flex-1">
        {/* Panes stay visible and stack by z-index: hiding a <webview> with
            visibility/display freezes its guest at the wrong size. The active
            pane's opaque background covers the others. */}
        <div
          className="absolute inset-0 overflow-y-auto bg-slate-100"
          style={{
            zIndex: activeId === 'overview' ? 2 : 0,
            pointerEvents: activeId === 'overview' ? 'auto' : 'none',
          }}
        >
          {overview}
        </div>
        {tabs.map(
          (t) =>
            t.url && (
              <div
                key={t.id}
                className="absolute inset-0 bg-white"
                style={{
                  zIndex: t.id === activeId ? 2 : 1,
                  pointerEvents: t.id === activeId ? 'auto' : 'none',
                }}
              >
                <webview
                  ref={refFor(t.id)}
                  src={t.url}
                  partition="persist:mvpfy-embedded"
                  style={{ display: 'flex', width: '100%', height: '100%' }}
                />
              </div>
            )
        )}
        {!activeTab.url &&
          activeTab.id !== 'overview' &&
          (activeTab.id === 'app' ? (
            <Placeholder>
              Start the environment — the running app will appear here.
            </Placeholder>
          ) : activeTab.id === 'ide' ? (
            ideUrl || ideStarting ? (
              <Placeholder>
                Starting VS Code (code-server)… first launch downloads the image.
              </Placeholder>
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
                  Runs open-source code-server in Docker with this project mounted. First
                  launch downloads the image (~300 MB).
                </p>
              </Placeholder>
            )
          ) : (
            <Placeholder>Loading…</Placeholder>
          ))}
      </div>
    </section>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white px-8 text-center text-sm text-slate-400">
      {children}
    </div>
  );
}
