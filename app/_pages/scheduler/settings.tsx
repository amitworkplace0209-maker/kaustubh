'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, RotateCcw, Save, Settings2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getSettings, resetSetting, updateSetting } from '@/lib/api';
import { fmtHHMM, useSchedulerData } from './scheduler-data';

const TIME_KEYS: { key: string; label: string; hint: string }[] = [
  { key: 'sched_login_time', label: 'Login', hint: 'Broker session login (default 08:50)' },
  { key: 'sched_ws_start_time', label: 'WS Connect', hint: 'WebSocket feed connect (default 08:55)' },
  { key: 'sched_tick_collection_start_time', label: 'Tick collection', hint: 'Tick capture start (default 08:59)' },
  { key: 'sched_pre_market_start_time', label: 'Pre-market', hint: 'Phase start (default 09:00)' },
  { key: 'sched_limit_order_start_time', label: 'Limit-order window', hint: 'Phase start (default 09:05)' },
  { key: 'sched_equilibrium_start_time', label: 'Equilibrium', hint: 'Phase start (default 09:10)' },
  { key: 'sched_buffer_start_time', label: 'Buffer', hint: 'Phase start (default 09:12)' },
  { key: 'sched_feed_start_time', label: 'Live feed', hint: 'Phase start (default 09:15)' },
  { key: 'sched_square_off_time', label: 'Square-off', hint: 'Auto square-off trigger (default 15:16)' },
  { key: 'sched_feed_stop_time', label: 'Feed stop', hint: 'Broker feed stop (default 15:30)' },
  { key: 'sched_ws_stop_time', label: 'WS Disconnect', hint: 'WebSocket stop (default 15:31)' },
  { key: 'sched_logout_time', label: 'Logout', hint: 'Broker session logout (default 16:00)' },
];

const BOOL_KEYS: { key: string; label: string; hint: string }[] = [
  { key: 'sched_enabled', label: 'Scheduler enabled', hint: 'Master switch — off = poora lifecycle parked' },
  { key: 'sched_square_off_enabled', label: 'Square-off enabled', hint: 'Off = 15:16 trigger skip hoga' },
];

const SELECT_KEYS: { key: string; label: string; hint: string }[] = [
  { key: 'sched_market_timezone', label: 'Market timezone', hint: 'Backend clock (Asia/Kolkata)' },
  { key: 'sched_trading_day_behavior', label: 'Trading-day behaviour', hint: 'Non-trading day par kya ho' },
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * SERVICES -> Scheduler -> Settings
 *
 * Real backend settings (authoritative sched_* keys). Har change PUT
 * /api/settings/{key} se persist hota hai aur backend runtime usse kuch
 * seconds me live consume kar leta hai. Effective schedule (aaj backend jo
 * use kar raha hai) side me dikhta hai taaki save ka asar verify ho sake.
 */
export default function SchedulerSettingsPage() {
  const { status, summary, reload: reloadSched } = useSchedulerData();
  const [docs, setDocs] = useState<Record<string, any> | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getSettings();
      const flat: Record<string, any> = res?.settings ?? res?.grouped?.scheduler ?? {};
      // getSettings returns {settings: flat, grouped}; flat keys -> doc
      const schedOnly: Record<string, any> = {};
      for (const [k, v] of Object.entries(flat)) {
        if (k.startsWith('sched_')) schedOnly[k] = v;
      }
      setDocs(schedOnly);
      setEdits({});
    } catch (e: any) {
      setError(e?.message ?? 'Settings load nahi ho payi.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchAll();
  }, []);

  const val = (key: string): string => {
    if (key in edits) return edits[key];
    const d = docs?.[key];
    const v = d?.value ?? '';
    return typeof v === 'boolean' ? String(v) : String(v ?? '');
  };

  const dirty = (key: string): boolean => key in edits && edits[key] !== String(docs?.[key]?.value ?? '');

  const saveOne = async (key: string) => {
    const raw = val(key);
    const doc = docs?.[key];
    let parsed: any = raw;
    if (typeof doc?.value === 'boolean') {
      parsed = raw === 'true';
    } else if (TIME_KEYS.some((t) => t.key === key)) {
      if (!HHMM.test(raw.trim())) {
        setError(`${key}: HH:MM format me time do (jaise 08:50).`);
        return;
      }
      parsed = raw.trim();
    }
    setSaving(key);
    setError(null);
    setNotice(null);
    try {
      await updateSetting(key, parsed);
      setNotice(`${key} save ho gaya — backend kuch seconds me live lega.`);
      await fetchAll();
      reloadSched();
    } catch (e: any) {
      setError(e?.message ?? `${key} save fail ho gaya.`);
    } finally {
      setSaving(null);
    }
  };

  const resetOne = async (key: string) => {
    setSaving(key);
    setError(null);
    try {
      await resetSetting(key);
      setNotice(`${key} default par reset ho gaya.`);
      await fetchAll();
      reloadSched();
    } catch (e: any) {
      setError(e?.message ?? `${key} reset fail ho gaya.`);
    } finally {
      setSaving(null);
    }
  };

  const effective: Record<string, string | null> = {
    Login: status?.todaySchedule?.login ?? summary?.day_schedule?.login ?? null,
    'WS Connect': status?.todaySchedule?.wsConnect ?? summary?.day_schedule?.ws_connect ?? null,
    'Tick collection': status?.todaySchedule?.tickCollection ?? summary?.day_schedule?.tick_collection ?? null,
    'WS Disconnect': status?.todaySchedule?.wsDisconnect ?? summary?.day_schedule?.ws_disconnect ?? null,
    Logout: status?.todaySchedule?.logout ?? summary?.day_schedule?.logout ?? null,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Settings2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Scheduler Settings</h1>
            <p className="text-xs text-muted-foreground">Authoritative <span className="font-mono">sched_*</span> keys · save karte hi backend live consume karta hai · IST (+05:30)</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {notice && <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-200"><CheckCircle2 className="mr-1 h-3 w-3" />Saved</Badge>}
          <Button size="sm" variant="outline" onClick={() => void fetchAll()}>
            <RefreshCw className="mr-1 h-3 w-3" /> Reload
          </Button>
        </div>
      </div>

      {error && <div className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"><AlertTriangle className="h-4 w-4" />{error}</div>}
      {notice && <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200"><CheckCircle2 className="h-4 w-4" />{notice}</div>}

      {loading && !docs ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading scheduler settings…</div>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Daily schedule (HH:MM)</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {TIME_KEYS.map(({ key, label, hint }) => {
                  const missing = !docs?.[key];
                  return (
                    <div key={key} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
                      <div className="min-w-36 flex-1">
                        <div className="text-xs font-semibold">{label} <span className="font-mono text-[10px] text-muted-foreground">{key}</span></div>
                        <div className="text-[10px] text-muted-foreground">{hint}{missing ? ' · backend default chal raha' : ''}</div>
                      </div>
                      <Input
                        value={val(key)}
                        placeholder="HH:MM"
                        onChange={(e) => setEdits((p) => ({ ...p, [key]: e.target.value }))}
                        className={`h-8 w-28 font-mono text-xs ${dirty(key) ? 'border-primary/60' : ''}`}
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
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Switches</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {BOOL_KEYS.map(({ key, label, hint }) => {
                    const on = val(key) === 'true';
                    return (
                      <div key={key} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                        <div><div className="text-xs font-semibold">{label}</div><div className="font-mono text-[10px] text-muted-foreground">{key} · {hint}</div></div>
                        <button
                          type="button"
                          onClick={() => {
                            setEdits((p) => ({ ...p, [key]: on ? 'false' : 'true' }));
                            setTimeout(() => void saveOne(key), 0);
                          }}
                          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-emerald-500' : 'bg-slate-600'}`}
                          title={on ? 'Off karo' : 'On karo'}
                        >
                          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
                        </button>
                      </div>
                    );
                  })}
                  {SELECT_KEYS.map(({ key, label, hint }) => (
                    <div key={key} className="rounded-lg border px-3 py-2">
                      <div className="text-xs font-semibold">{label}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{key} · {hint}</div>
                      <div className="mt-1.5 flex gap-2">
                        <Input value={val(key)} onChange={(e) => setEdits((p) => ({ ...p, [key]: e.target.value }))} className="h-8 font-mono text-xs" />
                        <Button size="sm" variant="outline" className="h-8 shrink-0" disabled={!dirty(key) || saving === key} onClick={() => void saveOne(key)}>
                          {saving === key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Effective aaj (backend)</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-xs">
                  {Object.entries(effective).map(([label, iso]) => (
                    <div key={label} className="flex justify-between"><span className="text-muted-foreground">{label}</span><span className="font-mono">{iso ? fmtHHMM(iso) : '—'}</span></div>
                  ))}
                  <p className="pt-1 text-[10px] text-muted-foreground">Ye backend calendar aaj actually jo use kar raha hai — save ke baad yahan verify karo.</p>
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
