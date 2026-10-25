'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Database, RefreshCw, ShieldCheck, Sliders, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { updateSetting } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DbwIstClock, DbwPageTabs, fmtNum } from './dbw-shared';

/**
 * SERVICES → DB Writer → Permissions — tick kya save hoga: CONTROL DESK.
 *
 * OWN connection (pages ke connections alag hain):
 *   GET  /api/services/engines/db_writer_engine/tick-persistence   (authoritative read)
 *   PUT  /api/services/engines/db_writer_engine/tick-persistence   (authoritative post-state)
 *   PUT  /api/settings/{dbw_storage_cap_*}                          (per-stream brake + reason)
 *
 * No WS#2, no polling — har mutation ka response hi naya authoritative state hai,
 * aur Refresh button se re-read. Overview page sirf READ-ONLY strip dikhata hai.
 */

const TICK_PERSISTENCE = '/api/services/engines/db_writer_engine/tick-persistence';

type PermissionState = {
  label?: string;
  settingKey?: string;
  enabled?: boolean;
  configuredEnabled?: boolean;
  hardCapped?: boolean;
  capSettingKey?: string;
  capEnvKey?: string;
  accepted?: number;
  skipped?: number;
};

type TPState = {
  master?: { label?: string; settingKey?: string; apiName?: string; enabled?: boolean; configuredEnabled?: boolean };
  effectiveSaving?: boolean;
  permissions?: Record<string, PermissionState>;
  storageCapActive?: boolean;
  storageCapReason?: string | null;
  storageCaps?: Record<string, boolean>;
  unknownSourceSkipped?: number;
  overlappingSourcesDeduped?: number;
  registryCache?: { entries?: number; refreshes?: number; ttlMs?: number };
};

const STREAM_KEYS = ['personalNoExpiry', 'personalOneDay', 'marketWatchOneDay'] as const;

export default function DbWriterPermissionsPage() {
  const [tp, setTp] = useState<TPState | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [capBusy, setCapBusy] = useState<string | null>(null);
  const [capReasonDraft, setCapReasonDraft] = useState<string | null>(null);

  /** Authoritative read — page ka apna connection. */
  const load = useCallback(async (): Promise<TPState | null> => {
    try {
      const res = await fetch(TICK_PERSISTENCE, { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!json?.ok) {
        const message = json?.error ?? `HTTP ${res.status}`;
        setErr(message);
        setUnavailable(/unavailable|could not persist|not connected/i.test(String(message)));
        return null;
      }
      const data = (json.data ?? {}) as TPState;
      setTp(data);
      setErr(null);
      setUnavailable(false);
      return data;
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Authoritative write: PUT ka response hi naya state hai. */
  const apply = useCallback(async (patch: Record<string, boolean>, label: string) => {
    setBusyKey('__all__');
    setNotice(null);
    setErr(null);
    try {
      const res = await fetch(TICK_PERSISTENCE, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => ({}));
      if (!json?.ok) {
        const message = json?.error ?? `HTTP ${res.status}`;
        setErr(message);
        setUnavailable(/unavailable|could not persist|storage cap/i.test(String(message)));
        setNotice({ kind: 'err', text: `${label}: reject ho gaya.` });
        await load();
      } else {
        setTp((json.data ?? {}) as TPState);
        setNotice({ kind: 'ok', text: label });
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setUnavailable(true);
      await load();
    } finally {
      setBusyKey(null);
    }
  }, [load]);

  const toggleMaster = (next: boolean) => {
    setBusyKey('master');
    void apply(
      { master: next },
      next ? 'MASTER ON — permissions decide karenge kaunsa tick save hoga.' : 'MASTER OFF — koi tick DB me save nahi hoga.',
    ).finally(() => setBusyKey((k) => (k === 'master' ? null : k)));
  };

  const toggleStream = (key: string, label: string, next: boolean) => {
    setBusyKey(key);
    void apply(
      { [key]: next },
      `${label} ${next ? 'ON' : 'OFF'} — next tick se effective.`,
    ).finally(() => setBusyKey((k) => (k === key ? null : k)));
  };

  /** Storage-cap brake: ON = stream ROko (permission ON ho tab bhi). */
  const toggleCap = async (settingKey: string, label: string, next: boolean) => {
    setCapBusy(settingKey);
    setErr(null);
    setNotice(null);
    try {
      await updateSetting(settingKey, next);
      setNotice({ kind: 'ok', text: `${label} cap ${next ? 'lagaya — stream ROOK diya' : 'hataya — permission wapas effective'}.` });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCapBusy(null);
    }
  };

  const saveCapReason = async () => {
    if (capReasonDraft == null) return;
    setCapBusy('reason');
    setErr(null);
    try {
      await updateSetting('dbw_storage_cap_reason', capReasonDraft);
      setNotice({ kind: 'ok', text: 'Cap reason save ho gaya.' });
      setCapReasonDraft(null);
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCapBusy(null);
    }
  };

  const master = tp?.master;
  const masterOn = master ? master.enabled !== false : true;
  const perms = (tp?.permissions ?? {}) as Record<string, PermissionState>;
  const caps = (tp?.storageCaps ?? {}) as Record<string, boolean>;
  const onCount = STREAM_KEYS.filter((k) => perms[k]?.enabled === true).length;
  const streamRows = STREAM_KEYS.map((key) => ({ key, perm: perms[key] ?? {} }));
  const rc = tp?.registryCache;

  if (loading) {
    return (
      <div className="space-y-4 pb-6">
        <div className="h-28 animate-pulse rounded-2xl bg-muted/60" />
        {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-muted/60" />)}
        <p className="text-center text-xs text-muted-foreground">Reading tick persistence authority…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-6">
      {/* HERO — violet control-desk band (alag look: left-blade + big switch) */}
      <div className="rounded-2xl border border-violet-500/30 bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-xl">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">DB Writer · Permission Desk</h1>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              tick-persistence authority · apna GET/PUT connection · authoritative state render hota hai
            </p>
          </div>
          <DbwPageTabs active="permissions" />
          <DbwIstClock />
          <Button size="sm" onClick={() => void load()} disabled={busyKey != null} className="gap-1.5 bg-gradient-to-r from-violet-500 to-purple-600 shadow-md">
            <RefreshCw className={cn('h-3.5 w-3.5', busyKey === '__all__' && 'animate-spin')} /> Re-read
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={cn(
            'font-mono',
            tp?.effectiveSaving ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/40 bg-rose-500/10 text-rose-700',
          )}>
            {tp?.effectiveSaving ? 'EFFECTIVE: SAVE HO RAHA' : 'EFFECTIVE: SAVE BAND'}
          </Badge>
          <Badge variant="outline" className={cn('font-mono', masterOn ? 'border-emerald-500/40 text-emerald-700' : 'border-rose-500/40 text-rose-700')}>
            {masterOn ? 'MASTER ON' : 'MASTER OFF'}
          </Badge>
          <Badge variant="outline" className="font-mono">{onCount}/3 streams ON</Badge>
          {tp?.storageCapActive && <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 font-mono text-amber-700">STORAGE CAP ACTIVE</Badge>}
        </div>
      </div>

      {err && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{unavailable ? 'Settings store unavailable — ' : 'Change rejected — '}{err}</span>
        </div>
      )}
      {notice && (
        <div className={cn(
          'flex items-center gap-2 rounded-xl border px-4 py-2.5 text-xs',
          notice.kind === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/30 bg-rose-500/10 text-rose-700',
        )}>
          {notice.kind === 'ok' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
          {notice.text}
        </div>
      )}

      {/* MASTER — bada switch, desk ka front panel */}
      <Card className="overflow-hidden border-violet-500/25 shadow-soft">
        <CardHeader className="bg-gradient-to-r from-violet-500/10 to-purple-500/5 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 p-1.5 text-white shadow"><Sliders className="h-3.5 w-3.5" /></span>
            1 · Master kill-switch — DB me tick save karna hai ya nahi
          </CardTitle>
        </CardHeader>
        <CardContent className={cn('flex flex-wrap items-center justify-between gap-4 p-4', masterOn ? 'bg-emerald-500/[0.04]' : 'bg-rose-500/[0.04]')}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-bold">{master?.label ?? 'Tick saving master switch'}</span>
              <Badge variant="outline" className="font-mono text-[10px]">{master?.settingKey ?? 'dbw_ticks_enabled'}</Badge>
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              {masterOn
                ? 'ON — neeche wale per-stream switches aur caps decide karenge kaunsa tick save hoga.'
                : 'OFF — koi bhi tick DB me save NAHI hoga, chahe neeche sab switches ON hon.'}
            </p>
          </div>
          <Switch
            checked={masterOn}
            disabled={busyKey != null}
            aria-label="Tick saving master switch"
            onCheckedChange={(checked) => toggleMaster(checked)}
          />
        </CardContent>
      </Card>

      {/* STREAMS — wide control rows (permission page ka signature) */}
      <Card className="overflow-hidden border-violet-500/25 shadow-soft">
        <CardHeader className="bg-gradient-to-r from-amber-500/10 to-yellow-500/5 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-amber-500 to-yellow-600 p-1.5 text-white shadow"><CheckCircle2 className="h-3.5 w-3.5" /></span>
            2 · Kaun-kaun se tick save honge (per-stream permission)
            {!masterOn && <Badge variant="outline" className="border-rose-500/40 font-mono text-[10px] text-rose-700">master OFF → sab effective OFF</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/40 pt-0">
          {tp?.storageCapActive && (
            <p className="px-3 py-2 text-xs text-amber-700" style={{ background: 'rgba(245, 158, 11, 0.06)' }}>
              {tp.storageCapReason}
            </p>
          )}
          {streamRows.map(({ key, perm }) => {
            const on = perm.enabled === true;
            const configured = perm.configuredEnabled === true;
            const saving = busyKey === key || busyKey === '__all__';
            const capped = perm.hardCapped === true || caps[key] === true;
            return (
              <div key={key} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{perm.label ?? key}</span>
                    <Badge variant={on ? 'default' : 'outline'} className="font-mono text-[10px]">{on ? 'ON' : 'OFF'}</Badge>
                    {!capped && configured !== on && (
                      <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                        stored: {configured ? 'ON' : 'OFF'}
                      </span>
                    )}
                    {capped && <Badge variant="outline" className="border-amber-500/50 font-mono text-[10px] text-amber-600">CAP LAGA HAI</Badge>}
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {perm.settingKey ?? '—'} · {fmtNum(perm.accepted)} accepted · {fmtNum(perm.skipped)} skipped
                    {perm.capSettingKey ? ` · cap: ${perm.capSettingKey}` : ''}
                  </p>
                </div>
                <Switch
                  checked={on}
                  disabled={saving || capped}
                  aria-label={`${perm.label ?? key} tick persistence`}
                  onCheckedChange={(checked) => toggleStream(key, perm.label ?? key, checked)}
                />
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2 px-3 py-3">
            <Button size="sm" variant="outline" disabled={busyKey != null} onClick={() => void apply({ master: true, personalNoExpiry: true, personalOneDay: true, marketWatchOneDay: true }, 'Master ON + teeno streams ON.')}>
              Enable all
            </Button>
            <Button size="sm" variant="outline" disabled={busyKey != null} onClick={() => void apply({ personalNoExpiry: false, personalOneDay: false, marketWatchOneDay: false }, 'Teeno permissions OFF.')}>
              Disable all
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Cap wala stream enable nahi hota — backend manage karta hai (reason ke saath reject).
            </span>
          </div>
        </CardContent>
      </Card>

      {/* CAP BRAKES + REASON */}
      <Card className="overflow-hidden border-amber-500/25 shadow-soft">
        <CardHeader className="bg-gradient-to-r from-amber-500/10 to-orange-500/5 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 p-1.5 text-white shadow"><AlertTriangle className="h-3.5 w-3.5" /></span>
            3 · Rok (brakes) — storage-cap per stream + reason
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-3">
          <p className="text-xs text-muted-foreground">
            Cap ON = stream ROOK do (permission ON ho tab bhi). Cap OFF = permission wapas effective. Runtime key live re-resolve hoti hai — restart nahi chahiye.
          </p>
          {streamRows.map(({ key, perm }) => {
            const capKey = perm.capSettingKey as string | undefined;
            const capped = perm.hardCapped === true || caps[key] === true;
            if (!capKey) return null;
            return (
              <div key={capKey} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.04] px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium">{perm.label ?? key} — rok</span>
                    <Badge variant="outline" className={cn('font-mono text-[10px]', capped ? 'border-amber-500/50 text-amber-600' : 'border-emerald-500/40 text-emerald-700')}>
                      {capped ? 'ROK LAGA HAI' : 'KHULA HAI'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{capKey}</p>
                </div>
                <Switch
                  checked={capped}
                  disabled={capBusy === capKey}
                  aria-label={`${perm.label ?? key} storage cap`}
                  onCheckedChange={(checked) => void toggleCap(capKey, perm.label ?? key, checked)}
                />
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/50 bg-muted/20 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">Rok ki wajah (reason)</p>
              <p className="font-mono text-[10px] text-muted-foreground">dbw_storage_cap_reason · panel + API me verbatim dikhta hai</p>
            </div>
            <Input
              value={capReasonDraft ?? tp?.storageCapReason ?? ''}
              placeholder="jaise: Atlas 512MB quota full"
              onChange={(e) => setCapReasonDraft(e.target.value)}
              className="h-8 w-56 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={capBusy === 'reason' || (capReasonDraft ?? tp?.storageCapReason ?? '') === (tp?.storageCapReason ?? '')}
              onClick={() => void saveCapReason()}
            >
              Save reason
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* REGISTRY CACHE — authority ke internals (page ka unique feature) */}
      <Card className="overflow-hidden border-violet-500/25 shadow-soft">
        <CardHeader className="bg-gradient-to-r from-violet-500/10 to-fuchsia-500/5 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 p-1.5 text-white shadow"><Database className="h-3.5 w-3.5" /></span>
            Registry cache — decision authority ke internals
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {rc ? (
            <div className="grid grid-cols-3 gap-2">
              {([['Entries', rc.entries], ['Refreshes', rc.refreshes], ['TTL (ms)', rc.ttlMs]] as [string, number | undefined][]).map(([l, v]) => (
                <div key={l} className="rounded-xl border border-border/50 bg-muted/30 px-2 py-2.5 text-center">
                  <p className="font-mono text-lg font-bold tabular-nums">{fmtNum(v)}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-2 text-center text-xs text-muted-foreground">Registry cache snapshot unavailable.</p>
          )}
          <p className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
            <X className="h-3 w-3" aria-hidden />
            Implicit drops (expired / inactive / duplicate / invalid / unknown-source): {fmtNum(tp?.unknownSourceSkipped)} unknown · {fmtNum(tp?.overlappingSourcesDeduped)} overlapping deduped — counters backend ne aapko pakde.
          </p>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Ye page SIRF apne tick-persistence endpoint se baat karta hai; WS#2 ya storage endpoint isse apni alag pages
        par chalte hain. Har toggle ka jawab backend ka authoritative state hai — UI khud se kabhi switch ka bol nahi.
      </p>
    </div>
  );
}
