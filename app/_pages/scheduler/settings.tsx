'use client';

/**
 * SERVICES → Scheduler → Settings — REAL, live-applied schedule controls.
 *
 * Har value authoritative `sched_*` keys se aati hai (Mongo) aur PUT ke turant
 * baad backend `settings_service` runtime cache refresh + scheduler ko wake
 * karta hai (request_reconcile). Engine apne agle reconcile tick (~5s) me
 * configured time + market timezone + trading-day behaviour LIVE adopt kar
 * leta hai — isi ka asar `settings-preview` endpoint me next-occurrence /
 * countdown / validation ke hisaab se dikhta hai (kuch bhi client-side pe
 * fake nahi hota: label/source/countdown sab backend se aate hain).
 *
 * Backend contracts used:
 *   GET  /api/settings              → {settings: {key: {value, category, updatedAt,...}}}
 *   PUT  /api/settings/{key}        → save one (validated server-side; 400 on bad value)
 *   POST /api/settings/{key}/reset  → delete override → default
 *   GET  /api/scheduler/settings-preview → effective values + next runs + validation issues
 *   GET  /api/scheduler/status      → engine state (live via useSchedulerData)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, BadgeCheck, Check, Clock, Loader2, RefreshCw, RotateCcw, Save, TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  getSchedulerSettingsPreview, getSchedulerStatus, getSettings, resetSetting, updateSetting,
} from '@/lib/api';
import { fmtHHMM, fmtRemaining, useNow } from './scheduler-data';

/* ------------------------------------------------------------------ */
/* Setting key catalog (all keys are real LIVE_KEYS consumers)         */
/* ------------------------------------------------------------------ */

const TIME_KEYS: { key: string; label: string; hint: string }[] = [
  { key: 'sched_login_time', label: 'Login', hint: 'Broker session login' },
  { key: 'sched_ws_start_time', label: 'WS Connect', hint: 'WebSocket feed connect' },
  { key: 'sched_tick_collection_start_time', label: 'Tick collection', hint: 'Tick capture start' },
  { key: 'sched_pre_market_start_time', label: 'Pre-market', hint: 'Phase start' },
  { key: 'sched_limit_order_start_time', label: 'Limit-order window', hint: 'Phase start' },
  { key: 'sched_equilibrium_start_time', label: 'Equilibrium', hint: 'Phase start' },
  { key: 'sched_buffer_start_time', label: 'Buffer', hint: 'Phase start' },
  { key: 'sched_feed_start_time', label: 'Live feed', hint: 'Phase start' },
  { key: 'sched_square_off_time', label: 'Square-off', hint: 'Auto square-off trigger' },
  { key: 'sched_feed_stop_time', label: 'Feed stop', hint: 'Broker feed stop' },
  { key: 'sched_ws_stop_time', label: 'WS Disconnect', hint: 'WebSocket stop' },
  { key: 'sched_logout_time', label: 'Logout', hint: 'Broker session logout' },
  { key: 'mwr_friday_scan_hhmm', label: 'Friday scan', hint: 'Market Watch Friday universe refresh (har Friday)' },
];

const BOOL_KEYS: { key: string; label: string; hint: string }[] = [
  { key: 'sched_enabled', label: 'Scheduler enabled', hint: 'Master switch — off = poora lifecycle parked' },
  { key: 'sched_square_off_enabled', label: 'Square-off enabled', hint: 'Off = square-off trigger skip' },
  { key: 'ws_auto_reconnect', label: 'WS auto reconnect', hint: 'Disconnect pe supervisor khud reconnect kare' },
  { key: 'ws_enabled', label: 'WebSocket enabled', hint: 'Off = WS supervisor band (feed window gate)' },
];

const NUM_KEYS: { key: string; label: string; hint: string; min: number; max: number }[] = [
  { key: 'ws_max_reconnect_attempts', label: 'Max reconnect attempts', hint: '0 = market window tak unlimited', min: 0, max: 100 },
  { key: 'ws_reconnect_delay_ms', label: 'Reconnect delay (ms)', hint: 'Backoff base delay', min: 500, max: 120000 },
];

const BEHAVIOR_OPTIONS = [
  { value: 'trading_days', label: 'Trading days — NSE calendar (weekend/holiday band)' },
  { value: 'weekdays', label: 'Weekdays — Mon–Fri har day (holiday bhi)' },
  { value: 'calendar_days', label: 'Calendar days — har din run (paper/soak)' },
];

const TIMEZONE_OPTIONS = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Singapore', 'Asia/Hong_Kong',
  'Asia/Tokyo', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'Australia/Sydney', 'UTC',
];

export default function SchedulerSettingsPage() {
  const nowMs = useNow(1000);
  const [docs, setDocs] = useState<Record<string, any> | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }, []);

  const loadPreview = useCallback(async () => {
    try {
      const p = await getSchedulerSettingsPreview();
      setPreview(p);
    } catch {
      /* keep last preview */
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const s = await getSchedulerStatus();
      setStatus(s);
    } catch {
      /* keep last status */
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getSettings();
      const flat: Record<string, any> = res?.settings ?? res?.grouped?.scheduler ?? {};
      const schedOnly: Record<string, any> = {};
      for (const [k, v] of Object.entries(flat)) {
        if (k.startsWith('sched_') || k.startsWith('ws_') || k === 'mwr_friday_scan_hhmm') schedOnly[k] = v;
      }
      setDocs(schedOnly);
      setEdits({});
      void loadPreview();
      void loadStatus();
    } catch (e: any) {
      setError(e?.message ?? 'Settings load nahi ho payi.');
    } finally {
      setLoading(false);
    }
  }, [loadPreview, loadStatus]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const val = useCallback((key: string): string => {
    if (key in edits) return edits[key];
    const d = docs?.[key];
    const v = d?.value;
    return typeof v === 'boolean' ? String(v) : String(v ?? '');
  }, [docs, edits]);

  const dirty = useCallback(
    (key: string) => key in edits && edits[key] !== String(docs?.[key]?.value ?? ''),
    [docs, edits],
  );

  const dirtyKeys = useMemo(() => Object.keys(edits).filter((k) => dirty(k)), [edits, dirty]);

  const saveOne = useCallback(async (key: string, rawOverride?: string) => {
    const doc = docs?.[key];
    const raw = rawOverride ?? val(key);
    let parsed: any = raw;
    const isTime = TIME_KEYS.some((t) => t.key === key);
    if (typeof doc?.value === 'boolean') {
      parsed = raw === 'true';
    } else if (isTime) {
      const m = /^([01]\d|2[0-3]):[0-5]\d$/.exec(raw.trim());
      if (!m) {
        setError(`${key}: HH:MM format me time do (jaise 08:50).`);
        return;
      }
      parsed = raw.trim();
    } else if (doc?.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        setError(`${key}: ek valid number do.`);
        return;
      }
      parsed = n;
    }
    setSaving(key);
    setError(null);
    setNotice(null);
    try {
      await updateSetting(key, parsed);
      flash(`${key} save ho gaya — scheduler agle reconcile tick (~5s) me live use karega.`);
      await fetchAll();
    } catch (e: any) {
      const msg = e?.message ?? `${key} save fail ho gaya.`;
      setError(typeof msg === 'string' ? msg : JSON.stringify(msg));
      void fetchAll();
    } finally {
      setSaving(null);
    }
  }, [docs, val, flash, fetchAll]);

  const saveAll = useCallback(async () => {
    const keys = dirtyKeys;
    if (keys.length === 0) return;
    setSavingAll(true);
    setError(null);
    let okCount = 0;
    const failed: string[] = [];
    for (const k of keys) {
      try {
        const doc = docs?.[k];
        let parsed: any = edits[k];
        if (typeof doc?.value === 'boolean') {
          parsed = edits[k] === 'true';
        } else if (TIME_KEYS.some((t) => t.key === k)) {
          const m = /^([01]\d|2[0-3]):[0-5]\d$/.exec(edits[k].trim());
          if (!m) { failed.push(`${k}: HH:MM galat`); continue; }
          parsed = edits[k].trim();
        } else if (doc?.type === 'number') {
          const n = Number(edits[k]);
          if (!Number.isFinite(n)) { failed.push(`${k}: number galat`); continue; }
          parsed = n;
        }
        await updateSetting(k, parsed);
        okCount += 1;
      } catch {
        failed.push(k);
      }
    }
    setSavingAll(false);
    if (okCount > 0) flash(`${okCount} setting save ho gayi — scheduler turant wake ho chuka hai.`);
    if (failed.length > 0) setError(`Save fail: ${failed.join(', ')} — values check karo.`);
    await fetchAll();
  }, [dirtyKeys, docs, edits, flash, fetchAll]);

  const resetOne = useCallback(async (key: string) => {
    setSaving(key);
    setError(null);
    try {
      await resetSetting(key);
      flash(`${key} default par reset ho gaya.`);
      await fetchAll();
    } catch (e: any) {
      setError(e?.message ?? `${key} reset fail ho gaya.`);
      void fetchAll();
    } finally {
      setSaving(null);
    }
  }, [flash, fetchAll]);

  const issues = (preview?.issues ?? []) as Array<{ code: string; severity: string; message: string }>;
  const issuesOk = preview?.issues_ok !== false;
  const entriesBy = useMemo(() => {
    const m: Record<string, any> = {};
    for (const e of preview?.entries ?? []) m[e.key] = e;
    return m;
  }, [preview]);

  const stateBadge = String(status?.schedulerState ?? '—');
  const isRunning = status?.schedulerState != null;

  return (
    <div className="space-y-4">
      {/* HEADER */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Clock className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Scheduler Settings</h1>
            <p className="text-xs text-muted-foreground">
              Yahan change karo wahi engine chalega · save pe scheduler turant wake + IST (+05:30)
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isRunning && (
            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 font-semibold text-emerald-800">
              engine: {stateBadge}
            </Badge>
          )}
          {preview && !issuesOk && (
            <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 font-semibold text-rose-800">
              {preview?.issue_error_count ?? 0} ordering error
            </Badge>
          )}
          {dirtyKeys.length > 0 && (
            <Button size="sm" onClick={() => void saveAll()} disabled={savingAll} className="gap-1.5 bg-gradient-to-r from-cyan-500 to-violet-500 shadow-md">
              {savingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save all ({dirtyKeys.length})
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => { void loadPreview(); void loadStatus(); }}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />{error}
          <button onClick={() => setError(null)} className="ml-auto text-rose-700 hover:text-rose-900">✕</button>
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800">
          <BadgeCheck className="h-4 w-4 shrink-0" />{notice}
          <button onClick={() => setNotice(null)} className="ml-auto text-emerald-700 hover:text-emerald-900">✕</button>
        </div>
      )}

      {loading && !docs ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading scheduler settings…</div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-3">
          {/* ------------ TIME-TABLE ------------ */}
          <Card className="overflow-hidden shadow-soft lg:col-span-2">
            <CardHeader className="bg-gradient-to-r from-cyan-500/10 to-violet-500/5 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-cyan-700" /> Daily schedule (HH:MM)
                <span className="ml-auto text-[11px] font-normal text-muted-foreground">time picker se select karo → Save</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-3">
              {TIME_KEYS.map(({ key, label, hint }) => {
                const missing = !docs?.[key] && docs != null;
                const eff = entriesBy[key]?.effective ?? null;
                return (
                  <div key={key} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-black/[0.02] px-3 py-2">
                    <div className="min-w-40 flex-1">
                      <div className="flex items-center gap-2 text-xs font-semibold">
                        {label}
                        <span className="font-mono text-[10px] font-normal text-muted-foreground">{key}</span>
                        {entriesBy[key]?.source === 'db'
                          ? <Badge variant="outline" className="h-4 px-1.5 py-0 text-[9px] text-emerald-800">DB</Badge>
                          : <Badge variant="outline" className="h-4 px-1.5 py-0 text-[9px] text-slate-600">default</Badge>}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {hint}{missing ? ' · backend default chal raha' : ''}
                        {eff && <span className="ml-2 font-mono text-cyan-700">effective {eff}</span>}
                      </div>
                    </div>
                    <Input
                      type="time"
                      value={val(key)}
                      onChange={(e) => setEdits((p) => ({ ...p, [key]: e.target.value }))}
                      className={`h-8 w-32 font-mono text-xs ${dirty(key) ? 'border-primary/60 ring-1 ring-primary/40' : ''}`}
                    />
                    <Button size="sm" variant="outline" className="h-8" disabled={!dirty(key) || saving === key} onClick={() => void saveOne(key)}>
                      {saving === key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />} Save
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 px-2" disabled={saving === key} onClick={() => void resetOne(key)} title="Default par reset">
                      <RotateCcw className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <div className="space-y-3">
            {/* ------------ BEHAVIOUR ------------ */}
            <Card className="overflow-hidden shadow-soft">
              <CardHeader className="bg-gradient-to-r from-violet-500/10 to-cyan-500/5 pb-2">
                <CardTitle className="text-sm">Engine behaviour</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pt-3">
                {BOOL_KEYS.map(({ key, label, hint }) => {
                  const on = val(key) === 'true';
                  return (
                    <div key={key} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-black/[0.02] px-3 py-2">
                      <div>
                        <div className="flex items-center gap-1.5 text-xs font-semibold">{label}<Badge variant="outline" className="h-4 px-1.5 py-0 text-[9px] text-slate-600">{docs?.[key]?.updatedAt ? 'DB' : 'default'}</Badge></div>
                        <div className="font-mono text-[10px] text-muted-foreground">{hint}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const next = on ? 'false' : 'true';
                          setEdits((p) => ({ ...p, [key]: next }));
                          void saveOne(key, next);
                        }}
                        disabled={saving === key}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${on ? 'bg-emerald-500' : 'bg-slate-400'}`}
                        title={on ? 'Off karo' : 'On karo'}
                      >
                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
                      </button>
                    </div>
                  );
                })}

                <div className="rounded-lg border border-border/60 bg-black/[0.02] px-3 py-2">
                  <div className="text-xs font-semibold">Trading-day behaviour</div>
                  <div className="font-mono text-[10px] text-muted-foreground">sched_trading_day_behavior · engine live ise padhta hai</div>
                  <select
                    value={val('sched_trading_day_behavior') || 'trading_days'}
                    onChange={(e) => {
                      setEdits((p) => ({ ...p, sched_trading_day_behavior: e.target.value }));
                      void saveOne('sched_trading_day_behavior', e.target.value);
                    }}
                    className="mt-1.5 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  >
                    {BEHAVIOR_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>

                <div className="rounded-lg border border-border/60 bg-black/[0.02] px-3 py-2">
                  <div className="text-xs font-semibold">Market timezone</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    sched_market_timezone{preview?.timezone_is_default === false && ' · ABHI NON-IST CHAL RAHA HAI'}
                  </div>
                  <select
                    value={val('sched_market_timezone') || 'Asia/Kolkata'}
                    onChange={(e) => {
                      setEdits((p) => ({ ...p, sched_market_timezone: e.target.value }));
                      void saveOne('sched_market_timezone', e.target.value);
                    }}
                    className="mt-1.5 h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-xs"
                  >
                    {TIMEZONE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {preview && <p className="mt-1 text-[10px] text-muted-foreground">backend clock: <span className="font-mono text-cyan-700">{preview.timezone_label}</span></p>}
                </div>

                {NUM_KEYS.map(({ key, label, hint, min, max }) => (
                  <div key={key} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-black/[0.02] px-3 py-2">
                    <div>
                      <div className="text-xs font-semibold">{label}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{hint} · {min}–{max}</div>
                    </div>
                    <Input
                      type="number"
                      min={min}
                      max={max}
                      value={val(key)}
                      onChange={(e) => setEdits((p) => ({ ...p, [key]: e.target.value }))}
                      onBlur={() => { if (dirty(key)) void saveOne(key); }}
                      className={`h-8 w-24 font-mono text-xs ${dirty(key) ? 'border-primary/60' : ''}`}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* ------------ VALIDATION (backend) ------------ */}
            <Card className={issuesOk ? 'shadow-soft' : 'border-rose-500/40 shadow-soft'}>
              <CardHeader className={(issuesOk ? 'bg-emerald-500/[0.06]' : 'bg-rose-500/[0.06]') + ' pb-2'}>
                <CardTitle className="flex items-center gap-2 text-sm">
                  {issuesOk ? <BadgeCheck className="h-4 w-4 text-emerald-700" /> : <TriangleAlert className="h-4 w-4 text-rose-700" />}
                  Validation {issues.length > 0 ? `(${issues.length})` : ''}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3 text-xs">
                {issues.length === 0 ? (
                  <p className="text-emerald-800">Schedule sahi hai — saare phases apni jagah hain.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {issues.map((i, idx) => (
                      <li key={idx} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${i.severity === 'error' ? 'border-rose-500/40 bg-rose-500/10 text-rose-800' : 'border-amber-500/40 bg-amber-500/10 text-amber-800'}`}>
                        <span className="font-mono font-bold">{i.code}</span> · {i.message}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* ------------ LIVE PREVIEW ------------ */}
            <Card className="overflow-hidden shadow-soft">
              <CardHeader className="bg-gradient-to-r from-cyan-500/10 to-emerald-500/5 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <RefreshCw className="h-3.5 w-3.5 text-cyan-700" /> Effective live
                  {preview?.next_event && (
                    <Badge variant="outline" className="ml-auto tabular-nums text-slate-700">next: {preview.next_event} {fmtHHMM(preview.next_event_at)} <span className="text-cyan-700">{liveCountdown(preview.next_event_at, preview.next_event_remaining_seconds, nowMs)}</span></Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 pt-3 text-xs">
                {[...TIME_KEYS].map(({ key, label }) => {
                  const e = entriesBy[key];
                  if (!e?.effective) return null;
                  return (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="flex items-center gap-1.5 font-mono">
                        {e.effective}
                        {e.source === 'db' ? <Check className="h-3 w-3 text-emerald-700" /> : <span className="text-[10px] text-muted-foreground">def</span>}
                      </span>
                    </div>
                  );
                })}
                <div className="mt-1 flex items-center justify-between border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
                  <span>aaj trading day: {preview?.today_trading_day ? 'haan' : 'nahi'}</span>
                  <span>behavior: <span className="font-mono">{preview?.trading_day_behavior ?? '—'}</span></span>
                </div>
                <p className="pt-1 text-[10px] text-muted-foreground">
                  Ye engine ki resolved live values hai (backend clock) — save ke baad yahan verify karo; countdown agle reconcile tick me update hota hai.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

/** Readonly countdown text from a backend absolute instant (client deltas only). */
function liveCountdown(nextAtIso?: string | null, fallbackSec?: number | null, nowMs?: number): string {
  if (nextAtIso) {
    const t = new Date(nextAtIso).getTime();
    const n = nowMs ?? Date.now();
    if (!Number.isNaN(t)) {
      const diff = Math.max(0, Math.floor((t - n) / 1000));
      return diff > 0 ? `· ${fmtRemaining(diff)}` : '· due';
    }
  }
  if (fallbackSec != null) {
    const s = Number(fallbackSec);
    if (!Number.isNaN(s) && s > 0) return `· ${fmtRemaining(s)}`;
  }
  return '';
}
