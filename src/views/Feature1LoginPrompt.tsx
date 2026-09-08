import { Feature1LoginState } from '../hooks/useFeature1Login';

/**
 * Sign in to Feature1, shown where the user asked for something that needs
 * it. Signing in opens the browser, so the wait is explained rather than
 * left as a button that appears to do nothing.
 */
export default function Feature1LoginPrompt({ login }: { login: Feature1LoginState }) {
  return (
    <div className="rounded-lg border border-line bg-sunken px-4 py-4">
      <p className="text-[13px] font-medium">Sign in to Feature1</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-body">
        Paste your Feature1 address — the one in your browser&apos;s address bar. mvpfy opens it so
        you can sign in there, then pulls the features assigned to you.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={login.address}
          onChange={(e) => login.setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void login.connect()}
          placeholder="acme.feature1.ai"
          spellCheck={false}
          disabled={login.status === 'waiting'}
          className="h-[34px] w-56 rounded-md border border-line bg-surface px-2.5 font-mono text-[12px] outline-none focus:border-muted disabled:opacity-60"
        />
        <button
          onClick={() => void login.connect()}
          disabled={login.status === 'waiting' || !login.address.trim()}
          className="btn-primary h-[34px] px-3.5 text-[13px] disabled:opacity-50"
        >
          {login.status === 'waiting' ? 'Waiting for sign-in…' : 'Sign in'}
        </button>
        {login.status === 'waiting' && (
          <span className="text-[12px] text-muted">Finish signing in in your browser.</span>
        )}
      </div>
      {login.status === 'error' && login.error && (
        <p className="mt-2.5 text-[12.5px] text-danger">{login.error}</p>
      )}
    </div>
  );
}
