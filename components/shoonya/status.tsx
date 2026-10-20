'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Radar, ShieldCheck, RefreshCw, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { ShoonyaShell } from '@/components/trading/shoonya-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getTerminalAccount } from '@/lib/terminal-service';
import { cn } from '@/lib/utils';

/**
 * Honest Shoonya terminal surfaces. The SDK (NorenRestApiOAuth 0.0.41) and the
 * backend adapter are real and verified; a live broker session only exists
 * after OAuth completes with backend secrets set. These components never
 * fabricate trading UI — before a session exists the terminal shows exactly
 * that status and nothing else.
 */
export function ShoonyaStatusPage() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
      <div className="flex items-center gap-3">
        <div className="rounded-lg border border-info/30 bg-info/10 p-2">
          <Radar className="h-5 w-5 text-info" />
        </div>
        <div>
          <h1 className="text-lg font-bold">Shoonya Terminal</h1>
          <p className="text-xs text-muted-foreground">Connection status &amp; OAuth</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="rounded-xl border border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Connection</CardTitle>
          </CardHeader>
          <CardContent>
            <ShoonyaShell />
            <p className="mt-2 text-[11px] text-muted-foreground">
              Orders, positions, holdings and market data are only served once a real session is
              active. Until then the terminal stays on this status view — no simulated data.
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Broker Health</CardTitle>
          </CardHeader>
          <CardContent>
            <BrokerHealthCard />
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-xl border border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Capabilities</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-xs text-muted-foreground">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 text-info" />
            <span>OAuth 2 login via NorenRestApiOAuth (SDK 0.0.41 verified).</span>
          </div>
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 text-info" />
            <span>Common terminal contract: funds, positions, holdings, orders, trade book,
              place / modify / cancel / square-off, search &amp; quote.</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function BrokerHealthCard() {
  const [status, setStatus] = useState<'loading' | 'connected' | 'error'>('loading');
  const [detail, setDetail] = useState<string>('');
  const mounted = useRef(true);

  const check = useCallback(async () => {
    setStatus('loading');
    setDetail('');
    try {
      await getTerminalAccount('shoonya');
      if (mounted.current) {
        setStatus('connected');
        setDetail('Broker session is active and healthy.');
      }
    } catch (err: any) {
      if (mounted.current) {
        setStatus('error');
        setDetail(err?.rawDetail ?? err?.message ?? 'Not connected — complete OAuth to activate.');
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    check();
    return () => { mounted.current = false; };
  }, [check]);

  return (
    <div className="space-y-3">
      <div className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
        status === 'connected' && 'border-success/30 bg-success/10 text-success',
        status === 'error' && 'border-warning/30 bg-warning/10 text-warning',
        status === 'loading' && 'border-border/60 bg-muted/30 text-muted-foreground',
      )}>
        {status === 'connected' && <CheckCircle2 className="h-3.5 w-3.5" />}
        {status === 'error' && <AlertTriangle className="h-3.5 w-3.5" />}
        {status === 'loading' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        <span className="font-medium">
          {status === 'connected' && 'Connected'}
          {status === 'error' && 'Not Connected'}
          {status === 'loading' && 'Checking…'}
        </span>
      </div>
      {detail && <p className="text-[11px] text-muted-foreground">{detail}</p>}
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-[10px]"
        onClick={check}
        disabled={status === 'loading'}
      >
        <RefreshCw className={cn('mr-1 h-3 w-3', status === 'loading' && 'animate-spin')} />
        Refresh Status
      </Button>
    </div>
  );
}

export function ShoonyaPending() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <div className="flex items-center gap-3">
        <div className="rounded-lg border border-info/30 bg-info/10 p-2">
          <Radar className="h-5 w-5 text-info" />
        </div>
        <div>
          <h1 className="text-lg font-bold">Connect to Shoonya Broker</h1>
          <p className="text-xs text-muted-foreground">Complete OAuth to access this section</p>
        </div>
      </div>

      <Card className="rounded-xl border border-border/60">
        <CardContent className="space-y-4 p-6">
          <div className="rounded-lg border border-info/20 bg-info/[0.06] p-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">How to Connect</h3>
            <ol className="space-y-2 text-xs text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-info/20 text-[10px] font-bold text-info">1</span>
                <span>Go to the <strong className="text-foreground">Dashboard</strong> and open the Shoonya connection panel in the sidebar.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-info/20 text-[10px] font-bold text-info">2</span>
                <span>Click <strong className="text-foreground">Open Shoonya OAuth</strong> to open the broker&apos;s authorization page in a new tab.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-info/20 text-[10px] font-bold text-info">3</span>
                <span>Sign in on the Shoonya portal and copy the one-time authorization code you receive.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-info/20 text-[10px] font-bold text-info">4</span>
                <span>Paste the code into the <strong className="text-foreground">One-time auth code</strong> field and click <strong className="text-foreground">Connect Shoonya</strong>.</span>
              </li>
            </ol>
          </div>

          <ShoonyaShell />

          <p className="text-[11px] text-muted-foreground">
            This section will show real broker data once an OAuth session is active. Until then
            the terminal stays on this connection page — nothing is simulated.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Connection gate for Shoonya trading pages: checks if the Shoonya broker
 * session is live via getTerminalAccount, then renders either children
 * (real trading UI) or the ShoonyaPending connection page.
 */
export function ShoonyaTradeGate({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;

    async function check() {
      try {
        await getTerminalAccount('shoonya');
        if (mounted.current && !cancelled) setConnected(true);
      } catch {
        if (mounted.current && !cancelled) setConnected(false);
      }
    }
    check();

    return () => { mounted.current = false; cancelled = true; };
  }, []);

  if (connected === null) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Checking broker connection…</span>
      </div>
    );
  }

  if (!connected) return <ShoonyaPending />;
  return <>{children}</>;
}
