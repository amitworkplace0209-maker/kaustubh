'use client';

/**
 * DashboardChat — floating live assistant for the Data Saver dashboard.
 *
 * A real, honest chat: it answers ONLY from the dashboard snapshot that is
 * already on screen (WS push preferred, REST fallback), and can run the same
 * actions the page buttons run (refresh data, open a sub-page). There is NO
 * hidden AI behind it — every answer quotes real, measured values, and when a
 * value cannot be measured it says "not measured" instead of inventing one.
 *
 * It never overlaps other surfaces: the FAB sits above the mobile bottom nav
 * (`bottom-nav-offset`, same slot contract as `PwaPrompts`), and the open
 * panel is capped to the viewport height with its own scroll.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, ChevronDown, CornerDownLeft, ExternalLink, MessageCircle,
  RefreshCw, Sparkles, Wifi, X,
} from 'lucide-react';
import Link from 'next/link';
import { fmtBytes } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { useDataSaver } from '@/components/phase2/data-saver-provider';

const DASH = '—';

type ChatRole = 'user' | 'bot';

interface ChatMessage {
  id: number;
  role: ChatRole;
  text: string;
  /** Optional footer chips after a bot answer (links / actions). */
  chips?: { label: string; href?: string; action?: 'refresh' }[];
}

const WELCOME: Omit<ChatMessage, 'id'> = {
  role: 'bot',
  text: [
    'Hi! I read the same live snapshot as this dashboard — nothing invented.',
    'Ask me about speed, storage, quality, alerts or the session. Or tap a chip below.',
  ].join('\n'),
};

const QUICK = ['Status', 'Speed', 'Storage', 'Quality', 'Alerts', 'Session'];

/** Format "value or honest em dash" for a number. */
function nfm(v: unknown, unit = ''): string {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : null;
  return n == null ? DASH : `${n.toLocaleString('en-IN')}${unit}`;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function DashboardChat() {
  const { data, refresh, transport, socketState, error, errorReason } = useDataSaver();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { ...WELCOME, id: 0, chips: [{ label: 'Status', action: undefined }, { label: 'Speed', action: undefined }] },
  ]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const nextId = useRef(1);

  const d: any = useMemo(() => data ?? {}, [data]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  }, []);

  useEffect(() => {
    if (open) scrollToEnd();
  }, [messages, open, scrollToEnd]);

  /** Build a bot answer from the REAL snapshot (or an honest not-measured line). */
  const answer = useCallback((q: string): Omit<ChatMessage, 'id'> => {
    const text = q.toLowerCase().trim();
    const sched = d.scheduler ?? {};
    const ws = d.ws ?? {};
    const pipe = d.pipeline ?? {};
    const mongo = d.mongo ?? {};
    const qual = d.quality ?? {};
    const alerts: any[] = Array.isArray(d.alerts) ? d.alerts : [];
    const activeAlerts = alerts.filter((a) => a && a.status !== 'resolved');

    const has = (...keys: string[]) => keys.some((k) => text.includes(k));

    if (has('refresh', 'update', 'reload')) {
      refresh();
      return { role: 'bot', text: 'Force refresh triggered — bypasses the REST cache and re-reads the backend.\nNew data lands on the page as soon as the backend answers.' };
    }
    if (has('speed', 'rate', 'ticks per', 'tps', 'latency', 'feed')) {
      return {
        role: 'bot',
        text: `Ticks / sec: ${nfm(pipe.ticksPerSec)}\nSave rate: ${pipe.savedPerSec != null ? `${nfm(pipe.savedPerSec)}/s` : DASH}\nFeed latency: ${typeof ws.latencyMs === 'number' ? `${Math.round(ws.latencyMs)}ms` : DASH}\nPipeline: ${String(pipe.state ?? 'unknown')}`,
        chips: [{ label: 'Tick Browser', href: '/data-saver/ticks' }],
      };
    }
    if (has('storage', 'disk', 'space', 'capacity', 'mongo', 'database', 'db')) {
      const used = typeof d.storage?.used === 'number' ? d.storage.used : null;
      const cap = typeof d.storage?.capacity === 'number' ? d.storage.capacity : null;
      const run = (a: number | null, b: number | null) => (a != null && b != null && b > 0 ? `${((a / b) * 100).toFixed(1)}% used` : DASH);
      return {
        role: 'bot',
        text: `Storage: ${run(used, cap)}${used != null && cap != null ? ` (${fmtBytes(used)} of ${fmtBytes(cap)})` : ''}\nMongoDB: ${mongo.connected ? 'connected' : 'disconnected'}\nTotal records: ${nfm(d.totalRecordsInDb)}`,
        chips: [{ label: 'Insights', href: '/data-saver/insights' }, { label: 'Downloads', href: '/data-saver/downloads' }],
      };
    }
    if (has('quality', 'score', 'duplicate', 'gap')) {
      return {
        role: 'bot',
        text: `Quality score (7d window): ${nfm(d.qualityScore)}/100\nDuplicates: ${nfm(qual.duplicates)} · Out-of-order: ${nfm(qual.outOfOrder)}\nSave failures: ${nfm(qual.saveFailures)}${d.qualityScoreFormula ? `\n\nFormula: ${d.qualityScoreFormula}` : ''}`,
        chips: [{ label: 'Quality report', href: '/data-saver/quality' }],
      };
    }
    if (has('alert', 'problem', 'issue', 'wrong')) {
      if (activeAlerts.length === 0 && !error) {
        return { role: 'bot', text: 'No active alerts — every monitored condition is inside its threshold right now.' };
      }
      const lines = activeAlerts.slice(0, 5).map((a) => `• [${String(a.severity ?? 'info')}] ${a.title ?? a.message}${error ? '' : ''}`);
      const errLine = error ? `• dashboard fetch failing — ${errorReason ?? 'backend unreachable'}` : '';
      return {
        role: 'bot',
        text: `${activeAlerts.length + (error ? 1 : 0)} active alert(s):\n${[...lines, errLine].filter(Boolean).join('\n')}`,
        chips: [{ label: 'Alert Center', href: '/data-saver/alerts' }],
      };
    }
    if (has('session', 'login', 'logged', 'broker')) {
      const sess = d.session ?? {};
      return {
        role: 'bot',
        text: `Broker session: ${sess.active ? 'ACTIVE' : 'inactive'}${sess.state ? ` (${String(sess.state).replace(/_/g, ' ')})` : ''}\nExpires in: ${typeof sess.remainingSeconds === 'number' ? `${Math.floor(sess.remainingSeconds / 60)}m` : DASH}\nLast login: ${sess.lastLoginAt ? timeAgo(sess.lastLoginAt) : DASH}${sess.loginSource ? ` (${String(sess.loginSource).toUpperCase()})` : ''}`,
        chips: [{ label: 'Configuration', href: '/data-saver/configuration' }],
      };
    }
    if (has('scheduler', 'market', 'open', 'closed', 'holiday', 'next')) {
      return {
        role: 'bot',
        text: `Market state: ${String(sched.marketState ?? sched.marketStatus ?? 'UNKNOWN').replace(/_/g, ' ')}\nScheduler: ${sched.running ? 'running' : 'stopped'}${sched.state ? ` · ${String(sched.state).replace(/_/g, ' ')}` : ''}\nNext event: ${sched.nextEvent ? `${String(sched.nextEvent).replace(/_/g, ' ')} @ ${sched.nextEventAt ?? DASH}` : 'none reported'}`,
        chips: [{ label: 'Schedules', href: '/data-saver/schedules' }],
      };
    }
    if (has('transport', 'socket', 'websocket', 'live', 'connection', 'how')) {
      return {
        role: 'bot',
        text: `Page transport: ${transport === 'live' ? 'WEBSOCKET push (WS#3) — snapshot updates stream in instantly' : 'REST polling (10s) — the socket is not connected right now'}\nSocket state: ${String(socketState).toLowerCase()}\nBackend feed (WS#1): ${ws.connected ? 'connected' : 'disconnected'}`,
        chips: [{ label: 'WebSocket page', href: '/data-saver/websocket' }],
      };
    }
    if (has('ticks today', 'today', 'records', 'count')) {
      return {
        role: 'bot',
        text: `Ticks today: ${nfm(d.ticksToday)}\nActive instruments: ${nfm(d.activeInstruments)}\nTotal records in DB: ${nfm(d.totalRecordsInDb)}`,
        chips: [{ label: 'Tick Browser', href: '/data-saver/ticks' }, { label: 'Insights', href: '/data-saver/insights' }],
      };
    }

    // Overview
    const market = sched.marketState ?? d.market?.marketState ?? 'UNKNOWN';
    return {
      role: 'bot',
      text: [
        `Pipeline: ${String(pipe.state ?? 'unknown')} · ${nfm(pipe.ticksPerSec)} ticks/s`,
        `Session: ${d.session?.active ? 'active' : 'inactive'} · Market: ${String(market).replace(/_/g, ' ').toLowerCase()}`,
        `Mongo: ${mongo.connected ? 'connected' : 'disconnected'} · Internet: ${d.net?.internetOk ? 'online' : 'offline'}`,
        `Data lane: ${transport === 'live' ? 'WS push' : 'REST poll'} · updated ${timeAgo(d.updatedAt)}`,
        'Ask me about speed / storage / quality / alerts / session — or say refresh.',
      ].join('\n'),
      chips: [
        { label: 'Speed', action: undefined },
        { label: 'Storage', action: undefined },
        { label: 'Alerts', action: undefined },
      ],
    };
  }, [d, error, errorReason, refresh, socketState, transport]);

  const send = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    const userMsg: ChatMessage = { id: nextId.current++, role: 'user', text };
    setMessages((m) => [...m, userMsg]);
    setDraft('');
    setBusy(true);
    // Small deliberate pause so the answer reads as a reply, not a flash.
    const t = setTimeout(() => {
      const a = answer(text);
      setMessages((m) => [...m, { ...a, id: nextId.current++ }]);
      setBusy(false);
      scrollToEnd();
    }, 350);
    return () => clearTimeout(t);
  }, [answer, busy, scrollToEnd]);

  // Esc closes the panel — one keyboard contract for the whole app shell.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* Floating action button — above the mobile bottom nav, like PwaPrompts. */}
      <button
        type="button"
        aria-label={open ? 'Close live assistant' : 'Open live assistant'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'bottom-nav-offset fixed right-3 z-bottom-nav flex h-14 w-14 items-center justify-center rounded-full',
          'bg-gradient-to-br from-teal-400 via-emerald-500 to-sky-500 shadow-lg shadow-emerald-500/30 ring-1 ring-white/20',
          'transition-transform duration-300 hover:scale-105 active:scale-95 md:right-6',
          !open && 'ds-float',
        )}
      >
        {open
          ? <ChevronDown className="h-6 w-6 text-white" />
          : <MessageCircle className="h-6 w-6 text-white" />}
        {!open && (
          <span aria-hidden className="absolute -right-0.5 -top-0.5 flex h-4 w-4">
            <span className={cn('absolute inline-flex h-full w-full rounded-full opacity-60',
              transport === 'live' ? 'ds-ping-soft bg-primary' : 'bg-warning')} />
            <span className={cn('relative inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-black text-primary-foreground',
              transport === 'live' ? 'bg-primary' : 'bg-warning')} >
              {transport === 'live' ? '•' : '!'}
            </span>
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div
          role="dialog"
          aria-label="Data Saver live assistant"
          className="bottom-nav-offset fixed right-3 z-bottom-nav w-[min(92vw,21rem)] md:right-6"
        >
          <div className="flex max-h-[70vh] flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/95 shadow-2xl backdrop-blur-xl">
            {/* Header */}
            <div className="flex items-center gap-2.5 border-b border-border/50 bg-gradient-to-r from-teal-500/10 via-emerald-500/10 to-sky-500/10 px-3.5 py-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-teal-400 to-sky-500 text-white shadow-md">
                <Bot className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold">Live Assistant</p>
                <p className={cn('flex items-center gap-1 truncate text-[9px] font-semibold uppercase tracking-[0.12em]',
                  transport === 'live' ? 'text-success' : 'text-muted-foreground')}>
                  <Wifi className="h-2.5 w-2.5" />
                  {transport === 'live' ? 'WS push · live data' : 'REST fallback'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
                className="rounded-lg p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Messages */}
            <div ref={listRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
              {messages.map((m) => (
                <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div className={cn(
                    'max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-[11px] leading-relaxed',
                    m.role === 'user'
                      ? 'rounded-br-md bg-primary text-primary-foreground'
                      : 'rounded-bl-md border border-border/50 bg-background/70',
                  )}>
                    {m.text}
                    {m.chips && m.chips.length > 0 && (
                      <span className="mt-2 flex flex-wrap gap-1.5">
                        {m.chips.map((c, i) => c.href ? (
                          <Link key={`${c.label}-${i}`} href={c.href} onClick={() => setOpen(false)}
                            className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-0.5 text-[9px] font-semibold text-muted-foreground transition hover:border-primary/40 hover:text-foreground">
                            <ExternalLink className="h-2.5 w-2.5" />{c.label}
                          </Link>
                        ) : (
                          <button
                            key={`${c.label}-${i}`}
                            type="button"
                            onClick={() => send(c.label)}
                            className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-0.5 text-[9px] font-semibold text-muted-foreground transition hover:border-primary/40 hover:text-foreground">
                            <Sparkles className="h-2.5 w-2.5" />{c.label}
                          </button>
                        ))}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {busy && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-border/50 bg-background/70 px-3 py-2">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/50"
                        style={{ animationDelay: `${i * 150}ms` }} />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Quick chips */}
            <div className="flex gap-1.5 overflow-x-auto border-t border-border/40 px-3 py-2 [scrollbar-width:none]">
              <button type="button" onClick={() => send('refresh')}
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary transition hover:bg-primary/20">
                <RefreshCw className="h-2.5 w-2.5" />Refresh
              </button>
              {QUICK.map((q) => (
                <button key={q} type="button" onClick={() => send(q)}
                  className="shrink-0 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[10px] font-semibold text-muted-foreground transition hover:border-border hover:text-foreground">
                  {q}
                </button>
              ))}
            </div>

            {/* Input */}
            <form
              className="flex items-center gap-2 border-t border-border/40 bg-background/60 px-3 py-2"
              onSubmit={(e) => { e.preventDefault(); send(draft); }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ask about speed, storage, alerts…"
                aria-label="Message the live assistant"
                className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/50"
              />
              <button
                type="submit"
                aria-label="Send"
                disabled={!draft.trim() || busy}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
              >
                <CornerDownLeft className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
