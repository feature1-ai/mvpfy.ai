interface Props {
  onConnect: () => void;
  onDismiss: () => void;
}

/**
 * Sticky strip under the top bar, shown once a feature has been planned on a
 * set-up project while Feature1 is still not connected (see lib/connectNudge).
 * It names what stays on this machine — the plan — and what connecting adds,
 * and leaves through the same Settings section the top-bar chip opens.
 */
export default function ConnectFeature1Banner({ onConnect, onDismiss }: Props) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-4 border-b border-line bg-surface px-5 py-2.5"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-dot-idle" />
      <p className="min-w-0 flex-1 text-[13px] text-body">
        <span className="font-medium text-ink">Your plan lives only on this Mac.</span> Connect
        Feature1 to share the PRD and stories with your team, track each story to Done, and let
        engineers pick them up from their own tools.
      </p>
      <button onClick={onConnect} className="btn-primary h-[30px] shrink-0 px-3 text-xs">
        Connect Feature1
      </button>
      <button onClick={onDismiss} className="btn-ghost h-[30px] shrink-0 px-2 text-xs text-muted">
        Not now
      </button>
    </div>
  );
}
