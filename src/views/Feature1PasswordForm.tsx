import { useState } from 'react';
import { Feature1LoginState } from '../hooks/useFeature1Login';

/**
 * Sign in with the same email and password as the Feature1 website.
 *
 * Shown only once the browser sign-in has proved this workspace keeps its
 * token rather than handing one back. The password is used for that one
 * request and never stored — only the token it returns is kept, in the OS
 * keychain, the same as any other route in.
 */
export default function Feature1PasswordForm({ login }: { login: Feature1LoginState }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submit = () => {
    if (email.trim() && password) void login.signIn(email.trim(), password);
  };
  return (
    <div className="mt-3 rounded-lg border border-line bg-sunken px-3.5 py-3">
      <p className="text-[12.5px] leading-relaxed text-body">
        This workspace does not hand a token back to apps yet, so sign in the way you do on the
        Feature1 website. mvpfy keeps only what that returns, in your keychain — never the password.
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="you@example.com"
          type="email"
          autoComplete="username"
          spellCheck={false}
          className="h-[32px] w-56 rounded-md border border-line bg-surface px-2.5 text-[12.5px] outline-none placeholder:text-faint focus:border-muted"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Password"
          type="password"
          autoComplete="current-password"
          className="h-[32px] w-44 rounded-md border border-line bg-surface px-2.5 text-[12.5px] outline-none placeholder:text-faint focus:border-muted"
        />
        <button
          onClick={submit}
          disabled={login.status === 'waiting' || !email.trim() || !password}
          className="btn-primary h-[32px] px-3 text-[12.5px] disabled:opacity-50"
        >
          {login.status === 'waiting' ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}
