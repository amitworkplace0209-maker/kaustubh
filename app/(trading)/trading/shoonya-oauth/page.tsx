'use client';

/**
 * Shoonya OAuth callback — `/trading/shoonya-oauth`.
 *
 * The Shoonya OAuth flow is a BROWSER REDIRECT:
 *
 *   1. the backend builds the OAuth URL (`GET /api/terminal/oauth-link`);
 *   2. the operator approves the app in the browser;
 *   3. Shoonya redirects here with the short-lived code;
 *   4. this page hands the code to the backend (`POST /api/terminal/oauth-code`),
 *      which exchanges it for the bearer token and stores it ENCRYPTED;
 *   5. from then on every restart and every terminal switch restores the
 *      session automatically — this page is needed ONCE per token.
 *
 * The code is used exactly once and is never persisted in the browser.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  acceptShoonyaAuthCode,
  connectTerminal,
  switchTerminal,
} from '@/lib/terminal-service';
import { useTradingMode } from '@/lib/settings-store';

type Phase = 'waiting' | 'working' | 'done' | 'failed';

export default function ShoonyaOAuthCallbackPage() {
  const router = useRouter();
  const mode = useTradingMode();
  const [phase, setPhase] = useState<Phase>('waiting');
  const [message, setMessage] = useState('Waiting for the Shoonya authorisation code…');

  const submit = useCallback(async () => {
    setPhase('working');
    setMessage('Exchanging the code with Shoonya…');
    try {
      // The code comes back either as a query parameter or in the fragment.
      const params = new URLSearchParams(window.location.search);
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const code = (params.get('code') || params.get('auth_code') || hash.get('code') || '').trim();
      if (!code) {
        setPhase('failed');
        setMessage(
          'No authorisation code arrived. Start the Shoonya login from the terminal screen and approve the app in the browser.',
        );
        return;
      }
      await acceptShoonyaAuthCode(code);
      setMessage('Code accepted — establishing the broker session…');
      // The broker only accepts an order for the ACTIVE terminal, so the
      // session is established on Shoonya itself.
      if (mode !== 'shoonya') {
        await switchTerminal('shoonya');
      }
      await connectTerminal('shoonya');
      setPhase('done');
      setMessage('Shoonya is connected. The session is stored encrypted — the next start is automatic.');
    } catch (err: any) {
      setPhase('failed');
      setMessage(err?.message ?? 'The Shoonya authorisation failed.');
    }
  }, [mode]);

  useEffect(() => {
    void submit();
  }, [submit]);

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col items-center justify-center gap-3 px-4 text-center">
      <span
        className={cn(
          'flex h-12 w-12 items-center justify-center rounded-xl',
          phase === 'done'
            ? 'bg-success/15 text-success'
            : phase === 'failed'
              ? 'bg-destructive/15 text-destructive'
              : 'bg-primary/15 text-primary',
        )}
      >
        {phase === 'done' ? (
          <CheckCircle2 className="h-6 w-6" />
        ) : phase === 'failed' ? (
          <XCircle className="h-6 w-6" />
        ) : (
          <Loader2 className="h-6 w-6 animate-spin" />
        )}
      </span>

      <h1 className="text-[17px] font-extrabold tracking-tight">Shoonya authorisation</h1>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{message}</p>

      {phase === 'failed' && (
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push('/trading/trade')} className="h-10">
            Back to the trade page
          </Button>
          <Button onClick={() => void submit()} className="h-10">
            Retry
          </Button>
        </div>
      )}

      {phase === 'done' && (
        <Button onClick={() => router.push('/trading/trade')} className="h-10">
          Go to the trade page
        </Button>
      )}

      {phase === 'working' && (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          The code is used once and never stored in the browser.
        </p>
      )}

      <p className="text-[11px] text-muted-foreground/80">
        Terminal: {mode === 'shoonya' ? 'Shoonya' : mode === 'kotak-neo' ? 'Kotak Neo' : 'Dummy'}
      </p>
    </div>
  );
}
