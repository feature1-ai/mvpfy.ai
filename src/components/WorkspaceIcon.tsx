export type WorkspaceIconName = 'overview' | 'plan' | 'agent' | 'app' | 'code' | 'logs';

const paths: Record<WorkspaceIconName, string> = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  plan: 'M8 4h13M8 12h13M8 20h13M3 4h.01M3 12h.01M3 20h.01',
  agent: 'M8 3h8l1 4h3v13H4V7h3z M8 12h.01M16 12h.01M9 16h6',
  app: 'M3 4h18v16H3z M3 9h18M7 6.5h.01M10 6.5h.01',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  logs: 'M4 5h16M4 12h10M4 19h12M18 10l3 3-3 3',
};

export default function WorkspaceIcon({ name }: { name: WorkspaceIconName }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={paths[name]} />
    </svg>
  );
}
