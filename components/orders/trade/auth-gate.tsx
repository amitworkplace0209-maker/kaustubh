'use client';

import { useState } from 'react';
import { Loader2, Lock, LogIn } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionCard } from '@/components/design-system';
import { loginWithPassword, type TerminalId } from '@/lib/terminal-service';

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/25';

/** In-memory JWT gate. Trading (place/connect audit-trail mutations) requires
 *  a live session token that is never persisted to storage. Shown honestly
 *  instead of faking a logged-in state. */
export function AuthGate({
  terminal,
  onAuthenticated,
}: {
  terminal: TerminalId;
  onAuthenticated: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError('Enter username and password.');
      return;
    }
    setBusy(true);
    setError('');
    const res = await loginWithPassword(username, password);
    setBusy(false);
    setPassword('');
    if (res.ok) {
      onAuthenticated();
    } else {
      setError(res.error ?? 'Login failed.');
    }
  };

  return (
    <SectionCard
      title="Session required"
      headerRight={<span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{terminal}</span>}
    >
      <p className="flex items-start gap-2 rounded-xl border border-xs border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-foreground/90">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        Trading actions need a signed-in session. The JWT is held in memory only and is never written to storage —
        the backend enforces this too (ops stay server-side).
      </p>

      <form onSubmit={submit} className="mt-3 space-y-2">
        <input
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={inputCls}
          placeholder="Username"
          aria-label="Username"
        />
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputCls}
          placeholder="Password"
          aria-label="Password"
        />
        {error && <p className="text-[11px] text-destructive">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className={cn(
            'inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary text-xs font-semibold text-primary-foreground',
            'transition-opacity hover:opacity-90 disabled:opacity-50',
          )}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
          {busy ? 'Signing in…' : 'Sign in to trade'}
        </button>
      </form>

      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground/70">
        Keep authenticated controls on the terminal page if the broker linked an OAuth/credentials flow. Dummy Mode
        accepts any identifiable session so the full honest pipeline still runs.
      </p>
    </SectionCard>
  );
}