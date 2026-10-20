'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Radar, RefreshCw } from 'lucide-react';
import { useTradingMode } from '@/lib/settings-store';
import {
  acceptShoonyaAuthCode,
  getShoonyaOAuthUrl,
  connectTerminal,
} from '@/lib/terminal-service';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Shoonya terminal shell — OAuth entry, one-time auth-code exchange, and real
 * session state. Renders ONLY when the trading terminal is switched to
 * SHOONYA. All statuses are honest (not enabled / not connected / connected).
 * Secrets (auth code, tokens) are exchanged over HTTPS and never persisted.
 * Broker sign-in is separate from terminal switching — never gated by the app
 * session or a password popup.
 */
export function ShoonyaShell({ collapsed = false }: { collapsed?: boolean }) {
  const mode = useTradingMode();
  const { toast } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const isActive = mode === 'shoonya';

  const loadOAuth = useCallback(async () => {
    if (!isActive) return;
    setLoadingUrl(true);
    try {
      const res = await getShoonyaOAuthUrl();
      if (!mounted.current) return;
      setEnabled(res?.enabled ?? false);
      setOauthUrl(res?.url ?? null);
    } catch (err: any) {
      if (mounted.current) {
        setEnabled(false);
        toast({ variant: 'destructive', title: 'Shoonya unavailable', description: err?.message });
      }
    } finally {
      if (mounted.current) setLoadingUrl(false);
    }
  }, [isActive, toast]);

  useEffect(() => {
    void loadOAuth();
  }, [loadOAuth, isActive, refreshKey]);

  const submitAuthCode = async () => {
    if (!code.trim()) return;
    setSubmitting(true);
    try {
      await acceptShoonyaAuthCode(code.trim());
      setCode('');
      toast({ title: 'Auth code accepted', description: 'One-time code exchanged — signing in…' });
      setLoadingUrl(true);
      try {
        await connectTerminal('shoonya');
        toast({ title: 'Shoonya connected', description: 'Session active.' });
      } catch (err: any) {
        toast({
          variant: 'destructive',
          title: 'Sign-in incomplete',
          description: err?.rawDetail ?? err?.message ?? 'login failed',
        });
      } finally {
        setLoadingUrl(false);
        setRefreshKey((k) => k + 1);
      }
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Code rejected', description: err?.rawDetail ?? err?.message });
    } finally {
      setSubmitting(false);
    }
  };

  if (!isActive) return null;

  if (collapsed) {
    return (
      <div className="flex justify-center py-1" title="SHOONYA TERMINAL">
        <Radar className={cn('h-4 w-4', enabled === false ? 'text-muted-foreground' : 'text-info')} />
      </div>
    );
  }

  return (
    <div className="mb-2 space-y-2 rounded-lg border border-border/60 bg-background/40 p-2">
      <div className="flex items-center gap-2">
        <Radar className="h-3.5 w-3.5 text-info" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-foreground">
          Shoonya Terminal
        </span>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={loadingUrl}
          className="ml-auto text-muted-foreground hover:text-foreground"
          aria-label="Refresh OAuth status"
        >
          <RefreshCw className={cn('h-3 w-3', loadingUrl && 'animate-spin')} />
        </button>
      </div>

      {enabled === false && (
        <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-[10px] text-warning">
          Shoonya terminal is not enabled — install the NorenRestApiOAuth SDK and set the
          SHOONYA_* secrets in the backend environment.
        </div>
      )}

      {enabled !== false && (
        <>
          {oauthUrl ? (
            <a
              href={oauthUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-md border border-border/60 bg-primary/10 px-2 py-1.5 text-[10px] font-medium text-primary hover:bg-primary/20"
            >
              <ExternalLink className="h-3 w-3" /> Open Shoonya OAuth
            </a>
          ) : (
            <div className="text-[10px] text-muted-foreground">
              {loadingUrl ? 'Preparing OAuth link…' : 'OAuth link unavailable.'}
            </div>
          )}

          <div className="space-y-1.5">
            <Input
              placeholder="One-time auth code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitAuthCode(); }}
              className="h-7 text-xs"
            />
            <Button
              size="sm"
              className="w-full text-[10px]"
              onClick={submitAuthCode}
              disabled={submitting || !code.trim()}
            >
              {submitting ? 'Exchanging…' : 'Connect Shoonya'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}