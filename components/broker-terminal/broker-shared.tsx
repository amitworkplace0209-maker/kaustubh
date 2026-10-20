'use client';

// Shared Broker Terminal building blocks — used by the Broker Terminal
// overview page AND the full Broker Profile page so the whole terminal area
// reads as one language. Presentation-only; every value is real backend data.

import { Building2, Cpu, Database, Gauge, Layers, PlugZap, Server, ShieldCheck, Wallet, Wifi } from 'lucide-react';
import { CARD_TONE, type AccentTone } from '@/components/design-system';
import { cn } from '@/lib/utils';
import { useRealtime } from '@/components/realtime-provider';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export const TERMINAL_META: Record<
  string,
  { name: string; sub: string; icon: React.ElementType; tone: AccentTone; kind: string }
> = {
  kotak: { name: 'Kotak Neo', sub: 'NSE · BSE · F&O · Currency', icon: Building2, tone: 'blue', kind: 'Live broker' },
  shoonya: { name: 'Shoonya', sub: 'Noren protocol', icon: Cpu, tone: 'orange', kind: 'Live broker' },
  dummy: { name: 'Dummy Mode', sub: 'Paper trading · virtual capital', icon: Wallet, tone: 'success', kind: 'Paper engine' },
  combined: { name: 'Combined', sub: 'Kotak Neo + Shoonya aggregate', icon: Layers, tone: 'purple', kind: 'Capital aggregate' },
};

/** Every terminal id the engine can report, in display order. */
export const TERMINAL_IDS = ['kotak', 'shoonya', 'dummy'] as const;

/** Single source of truth for a terminal's accent — used by every broker page. */
export const terminalTone = (id: string): AccentTone => TERMINAL_META[id]?.tone ?? 'neutral';

// ---------------------------------------------------------------------------
// Proper names — machine tokens resolved to labels an operator can read
// ---------------------------------------------------------------------------

export interface ProperName {
  label: string;
  blurb: string;
  known: boolean;
  icon?: string;
}

function lookup(table: Record<string, ProperName>, token: string | null | undefined): ProperName | null {
  const t = String(token ?? '').trim();
  if (!t) return null;
  const hit = table[t.toUpperCase()] ?? table[t];
  if (hit) return hit;
  return { label: t, blurb: 'Not in the known vocabulary — shown verbatim.', known: false };
}

/**
 * `sessionState` vocabulary emitted by the broker adapters
 * (`services/broker_terminal_engine.py` + the adapter layer).
 */
const SESSION_STATES: Record<string, ProperName> = {
  SESSION_ACTIVE: { label: 'Session Active', blurb: 'Broker session is open and authenticated.', known: true, icon: 'ShieldCheck' },
  WS_ACTIVE: { label: 'Socket Live', blurb: 'Broker WebSocket is streaming.', known: true, icon: 'Radio' },
  ACTIVE: { label: 'Active', blurb: 'Adapter is active.', known: true },
  CONNECTED: { label: 'Connected', blurb: 'Adapter has a live connection.', known: true },
  LOGGED_IN: { label: 'Logged In', blurb: 'Credentials accepted by the broker.', known: true },
  NOT_LOGGED_IN: { label: 'Logged Out', blurb: 'No authenticated broker session.', known: true },
  LOGGED_OUT: { label: 'Logged Out', blurb: 'No authenticated broker session.', known: true },
  INACTIVE: { label: 'Inactive', blurb: 'Adapter idle, no session.', known: true },
  EXPIRED: { label: 'Expired', blurb: 'Session token expired — re-login required.', known: true },
  AUTH_FAILED: { label: 'Auth Failed', blurb: 'Broker rejected the credentials.', known: true },
  DISCONNECTED: { label: 'Disconnected', blurb: 'Socket dropped.', known: true },
  CONNECTING: { label: 'Connecting', blurb: 'Handshake in progress.', known: true },
  STARTING: { label: 'Starting', blurb: 'Adapter is coming up.', known: true },
  UNAVAILABLE: { label: 'Unavailable', blurb: 'Backend could not read this terminal.', known: true },
  NOT_CONFIGURED: { label: 'Not Configured', blurb: 'Adapter disabled — no credentials configured.', known: true },
  UNKNOWN: { label: 'Unknown', blurb: 'Backend reported no session state.', known: true },
};

/** Order lifecycle states from the broker APIs. */
const ORDER_STATES: Record<string, ProperName> = {
  COMPLETE: { label: 'Complete', blurb: 'Fully filled and closed.', known: true },
  FILLED: { label: 'Filled', blurb: 'Quantity fully filled.', known: true },
  EXECUTED: { label: 'Executed', blurb: 'Exchange executed the order.', known: true },
  OPEN: { label: 'Open', blurb: 'Working at the exchange.', known: true },
  PENDING: { label: 'Pending', blurb: 'Submitted, awaiting exchange response.', known: true },
  NEW: { label: 'New', blurb: 'Accepted by the broker, not yet at the exchange.', known: true },
  TRIGGER_PENDING: { label: 'Trigger Pending', blurb: 'Waiting for its trigger condition.', known: true },
  CANCELLED: { label: 'Cancelled', blurb: 'Withdrawn before execution.', known: true },
  CANCELED: { label: 'Cancelled', blurb: 'Withdrawn before execution.', known: true },
  REJECTED: { label: 'Rejected', blurb: 'Broker/exchange refused the order.', known: true },
  REJECT: { label: 'Rejected', blurb: 'Broker/exchange refused the order.', known: true },
  PARTIAL: { label: 'Partial', blurb: 'Partially filled, remainder working.', known: true },
  MODIFY: { label: 'Modified', blurb: 'Order amended.', known: true },
  CANCEL_REQUEST: { label: 'Cancel Requested', blurb: 'Cancellation sent, awaiting confirmation.', known: true },
};

/** Audit `kind` values written by the terminal gateway. */
const AUDIT_KINDS: Record<string, ProperName> = {
  decision: { label: 'Decision', blurb: 'Routing or authorisation decision.', known: true },
  action: { label: 'Action', blurb: 'An action was executed against the broker.', known: true },
  system: { label: 'System', blurb: 'Lifecycle/system event.', known: true },
  security: { label: 'Security', blurb: 'Authentication or credential event.', known: true },
};

/** Product segments the adapters can route to. */
const PRODUCT_HINTS: Record<string, string> = {
  NSE: 'Equity · NSE',
  BSE: 'Equity · BSE',
  NFO: 'F&O · NSE',
  BFO: 'F&O · BSE',
  CDS: 'Currency · NSE',
  BCD: 'Currency · BSE',
  MCX: 'Commodity',
  EQUITIES: 'Equity',
  FUTURES: 'Futures',
  OPTIONS: 'Options',
  CURRENCY: 'Currency',
  COMMODITY: 'Commodity',
  MIS: 'Intraday (MIS)',
  CNC: 'Delivery (CNC)',
  NRML: 'Normal (NRML)',
};

export const sessionStateName = (s: string | null | undefined) => lookup(SESSION_STATES, s);
export const orderStateName = (s: string | null | undefined) => lookup(ORDER_STATES, s);
export const auditKindName = (s: string | null | undefined) => lookup(AUDIT_KINDS, s);
export const productHint = (p: string) => PRODUCT_HINTS[String(p ?? '').toUpperCase()] ?? null;

/** Order-status -> badge tone, driven by the backend's own vocabulary. */
export function orderBadge(status: string | null | undefined): { status: Tone; label: string } {
  const s = String(status ?? '').toUpperCase();
  const p = orderStateName(status);
  if (/COMPLETE|FILLED|EXECUTED|OPEN/.test(s)) return { status: 'success', label: p?.label ?? s };
  if (/REJECT|CANCEL/.test(s)) return { status: 'danger', label: p?.label ?? s };
  if (/PENDING|NEW|TRIGGER|PARTIAL|MODIFY/.test(s)) return { status: 'warning', label: p?.label ?? s };
  return { status: 'neutral', label: p?.label ?? (s || 'UNKNOWN') };
}

/** Audit kind -> tailwind classes for its chip. */
export const AUDIT_KIND_CLS: Record<string, string> = {
  decision: 'border-warning/40 bg-warning/10 text-warning',
  action: 'border-success/40 bg-success/10 text-success',
  system: 'border-border bg-muted text-muted-foreground',
  security: 'border-destructive/40 bg-destructive/10 text-destructive',
};

/** Stable accent per terminal id so one broker keeps one colour everywhere. */
export function terminalHue(id: string): string {
  switch (id) {
    case 'kotak':
      return 'hsl(217 91% 60%)';
    case 'shoonya':
      return 'hsl(25 95% 53%)';
    case 'dummy':
      return 'hsl(142 70% 45%)';
    case 'combined':
      return 'hsl(265 85% 58%)';
    default:
      return 'hsl(var(--muted-foreground))';
  }
}

export const ACCENT_TEXT: Record<AccentTone, string> = {
  success: 'text-success',
  danger: 'text-destructive',
  warning: 'text-warning',
  orange: 'text-orange-600 dark:text-orange-400',
  teal: 'text-teal',
  cyan: 'text-cyan-600 dark:text-cyan-400',
  blue: 'text-blue-600 dark:text-blue-400',
  purple: 'text-purple',
  violet: 'text-violet-600 dark:text-violet-400',
  neutral: 'text-muted-foreground',
};

const ACCENT_BAR: Record<AccentTone, string> = {
  success: 'border-l-success',
  danger: 'border-l-destructive',
  warning: 'border-l-warning',
  orange: 'border-l-orange-500',
  teal: 'border-l-teal',
  cyan: 'border-l-cyan-500',
  blue: 'border-l-blue-500',
  purple: 'border-l-purple',
  violet: 'border-l-violet-500',
  neutral: 'border-l-border',
};

export const ACTIVE_BADGE_CLS = 'border-primary/40 bg-primary/15 text-primary';

export function pnlToneValue(v: number | null | undefined): AccentTone {
  if (v == null || !Number.isFinite(v)) return 'neutral';
  return v > 0 ? 'success' : v < 0 ? 'danger' : 'neutral';
}

/** Session-state string -> honest badge (UNKNOWN stays neutral, never faked). */
export function sessionBadge(state: string | null | undefined, connected?: boolean): { status: Tone; label: string } {
  const s = String(state ?? '').toUpperCase();
  if (!s && connected != null) return connected ? { status: 'success', label: 'CONNECTED' } : { status: 'danger', label: 'DISCONNECTED' };
  if (/EXPIRED|NOT_LOGGED|LOGGED_OUT|CLOSED|DISCONNECTED|AUTH_FAILED|ERROR/.test(s)) return { status: 'danger', label: s || 'ERROR' };
  if (/ACTIVE|CONNECTED|LOGGED_IN|OPEN|MANAGED|READY|WS_ACTIVE/.test(s)) return { status: 'success', label: s || 'CONNECTED' };
  if (/STARTING|CONNECTING|RECONNECT|WAITING/.test(s)) return { status: 'warning', label: s || 'CONNECTING' };
  if (/NOT_CONFIGURED|DISABLED|UNAVAILABLE/.test(s)) return { status: 'warning', label: s || 'UNAVAILABLE' };
  return { status: 'neutral', label: s || 'UNKNOWN' };
}

export function severityBadge(sev: string | null | undefined): { status: Tone; label: string } {
  const s = String(sev ?? '').toUpperCase();
  if (/CRITICAL|ERROR/.test(s)) return { status: 'danger', label: s || 'ERROR' };
  if (/WARN/.test(s)) return { status: 'warning', label: s || 'WARNING' };
  if (/INFO/.test(s)) return { status: 'info', label: s || 'INFO' };
  return { status: 'neutral', label: s || 'ALERT' };
}

/** Mask a session/terminal id — never show the full credential-like value. */
export function maskId(id: string | null | undefined): string {
  if (!id) return '\u2014';
  if (id.length <= 6) return `${id.slice(0, 2)}…`;
  return `${id.slice(0, 4)}…${id.slice(-2)}`;
}

export function sessionManagerTs(iso: unknown): string {
  if (!iso) return '\u2014';
  const d = new Date(String(iso));
  return Number.isNaN(d.getTime()) ? '\u2014' : d.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
}

/** Defensive field helpers for real adapter rows (tolerant of plural key names). */
export function pickStr(row: Record<string, any> | null | undefined, keys: string[]): string {
  if (!row) return '\u2014';
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v) !== '') return String(v);
  }
  return '\u2014';
}

export function pickNum(row: Record<string, any> | null | undefined, keys: string[]): number | null {
  if (!row) return null;
  for (const k of keys) {
    const v = row[k];
    if (v == null || v === '') continue;
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v).replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function MiniMetric({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('truncate text-sm font-semibold tabular-nums', valueClass)}>{value}</p>
    </div>
  );
}

/** Small individual metric card with a tone-colored left accent. */
export function MiniCard({ label, value, valueClass, tone = 'neutral', loading }: {
  label: string; value: string; valueClass?: string; tone?: AccentTone; loading?: boolean;
}) {
  return (
    <div className={cn('min-w-0 rounded-lg border border-border/60 border-l-2 bg-muted/30 px-2.5 py-2', ACCENT_BAR[tone])}>
      <p className="truncate text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      {loading ? (
        <p className="tabular-nums text-[13px] font-semibold text-muted-foreground/50">\u2026</p>
      ) : (
        <p className={cn('truncate text-[13px] font-semibold tabular-nums', valueClass)}>{value}</p>
      )}
    </div>
  );
}

export function InfoRow({ label, value, mono, valueClass }: { label: string; value: React.ReactNode; mono?: boolean; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate text-right text-sm font-medium tabular-nums', mono && 'font-mono', valueClass)}>
        {value}
      </span>
    </div>
  );
}

/** Rounded bordered card shell used across the lower overview/profile cards. */
export function SectionShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-border bg-card p-4 shadow-soft h-full', className)}>
      {children}
    </div>
  );
}

/** Colored section-card heading (icon chip tinted by tone). */
export function SectionCardHead({ icon: Icon, title, tone = 'neutral', right }: {
  icon: React.ElementType; title: string; tone?: AccentTone; right?: React.ReactNode;
}) {
  const t = CARD_TONE[tone];
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span className={cn('flex h-5 w-5 items-center justify-center rounded-md ring-1 ring-inset', t.icon)}>
          <Icon className="h-3 w-3" />
        </span>
        {title}
      </h3>
      {right}
    </div>
  );
}

// ---- System Status strip (ONE realtime source) ------------------------------

type StripItem = {
  key: string;
  title: string;
  caption: string;
  state: 'ON' | 'OFF' | 'UNKNOWN';
  icon: React.ElementType;
};

const STRIP_ICONS = { db: Database, api: Server, login: ShieldCheck, ws: PlugZap, sched: Gauge, net: Wifi };

export function buildStrip(rt: ReturnType<typeof useRealtime>): StripItem[] {
  const s = rt.state ?? {};
  const db = s.database?.connected;
  const sched = s.scheduler ?? {};
  const appConn = rt.appConnection;
  const login = rt.sessionActive;
  const wscaption = String(rt.brokerWsState ?? 'UNKNOWN');
  const ws = rt.brokerWsConnected;
  const net = rt.internetConnected;

  const toState = (v: boolean | null | undefined): 'ON' | 'OFF' | 'UNKNOWN' =>
    v == null ? 'UNKNOWN' : v ? 'ON' : 'OFF';

  return [
    { key: 'mongodb', title: 'MongoDB', caption: db == null ? 'unknown' : db ? 'connected' : 'disconnected', state: toState(db), icon: STRIP_ICONS.db },
    { key: 'fastapi', title: 'FastAPI', caption: appConn, state: appConn === 'CONNECTED' ? 'ON' : appConn === 'CONNECTING' || appConn === 'RECONNECTING' ? 'UNKNOWN' : 'OFF', icon: STRIP_ICONS.api },
    { key: 'kotak-login', title: 'Kotak Neo Login', caption: String(rt.sessionStatus ?? 'UNKNOWN').toLowerCase(), state: login === true ? 'ON' : login === false ? 'OFF' : 'UNKNOWN', icon: STRIP_ICONS.login },
    { key: 'websocket', title: 'WebSocket', caption: wscaption.toLowerCase(), state: ws === true ? 'ON' : ws === false ? 'OFF' : 'UNKNOWN', icon: STRIP_ICONS.ws },
    { key: 'scheduler', title: 'Scheduler', caption: String(sched.state ?? (sched.running ? 'running' : 'stopped')).toLowerCase(), state: sched.running == null ? 'UNKNOWN' : sched.running ? 'ON' : 'OFF', icon: STRIP_ICONS.sched },
    { key: 'internet', title: 'Internet', caption: net == null ? 'unknown' : net ? 'connected' : 'offline', state: toState(net), icon: STRIP_ICONS.net },
  ];
}

const STRIP_DOT: Record<StripItem['state'], string> = {
  ON: 'bg-success',
  OFF: 'bg-destructive',
  UNKNOWN: 'bg-muted-foreground/50',
};

export function SystemStatusStrip() {
  const rt = useRealtime();
  const items = buildStrip(rt);
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      {items.map((it) => (
        <div
          key={it.key}
          data-verify={`strip-${it.key}`}
          className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-card px-3 py-2.5 shadow-soft"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
            <it.icon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium text-muted-foreground">{it.title}</p>
            <p className="flex items-center gap-1.5 truncate text-[11px] font-semibold tabular-nums">
              <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STRIP_DOT[it.state])} />
              {it.caption}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}