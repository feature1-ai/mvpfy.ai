import { useEffect, useRef, useState } from 'react';
import { Project } from '../../shared/types';
import logoUrl from '../../assets/logo.svg';

interface Props {
  projects: Project[];
  activeProjectId: string | null;
  tenantConnected: boolean;
  tenantSlug: string | null;
  onSelectProject: (id: string) => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
}

export default function TopBar({
  projects,
  activeProjectId,
  tenantConnected,
  tenantSlug,
  onSelectProject,
  onAddProject,
  onOpenSettings,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = projects.find((p) => p.id === activeProjectId) ?? null;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const name = (p: Project) => p.localPath.split('/').pop() ?? p.id;
  const running = (p: Project) => p.status === 'running';

  return (
    <header className="sticky top-0 z-20 flex h-[52px] shrink-0 items-center gap-4 border-b border-line bg-surface px-5">
      <div className="flex items-baseline gap-2 border-r border-line pr-4">
        <img src={logoUrl} alt="#mvpFY" className="h-5 translate-y-[3px]" />
        <span className="text-[11px] tracking-[0.02em] text-muted">
          the IDE for PMs · by{' '}
          <button
            onClick={() => void window.mvpfy.openExternal('https://feature1.ai')}
            className="hover:text-body hover:underline"
            title="feature1.ai"
          >
            feature1
          </button>
        </span>
      </div>

      {projects.length > 0 && (
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-8 items-center gap-2 rounded-md border border-line bg-paper px-2.5 text-[13px] font-medium hover:bg-hoverfill"
          >
            <span
              className={`h-[7px] w-[7px] rounded-full ${
                active && running(active) ? 'bg-go' : 'bg-dot-idle'
              }`}
            />
            {active ? name(active) : 'Select project'}
            <span className="text-[10px] text-muted">▾</span>
          </button>
          {menuOpen && (
            <div className="absolute left-0 top-[38px] z-30 w-[300px] rounded-lg border border-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(27,26,23,.10)]">
              <div className="section-label px-2.5 pb-1.5 pt-2">Projects</div>
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onSelectProject(p.id);
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-[9px] text-left hover:bg-paper"
                >
                  <span
                    className={`h-[7px] w-[7px] rounded-full ${running(p) ? 'bg-go' : 'bg-dot-idle'}`}
                  />
                  <span className="flex-1 truncate text-[13px] font-medium">{name(p)}</span>
                  <span className="font-mono text-[11px] text-muted">
                    {running(p) ? `:${p.basePort}` : 'stopped'}
                  </span>
                </button>
              ))}
              <div className="my-1.5 border-t border-line" />
              <button
                onClick={() => {
                  onAddProject();
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-[9px] text-left text-[13px] hover:bg-paper"
              >
                <span className="text-muted">＋</span> Add project…
              </button>
            </div>
          )}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <span className="mr-2 hidden items-center gap-1.5 text-xs text-muted sm:flex">
          <span
            className={`h-1.5 w-1.5 rounded-full ${tenantConnected ? 'bg-go' : 'bg-dot-idle'}`}
          />
          {tenantConnected ? `Feature1 · ${tenantSlug}` : 'Feature1 not connected ·'}
          {!tenantConnected && (
            <button
              onClick={onOpenSettings}
              className="text-go hover:text-go-hover hover:underline"
            >
              connect
            </button>
          )}
        </span>
        <button onClick={onOpenSettings} className="btn-ghost h-[30px] px-3">
          Settings
        </button>
        <button onClick={onAddProject} className="btn-primary h-[30px] px-3">
          Add project
        </button>
      </div>
    </header>
  );
}
