'use client';

/**
 * SERVICES → Order Engine → SETTINGS.
 *
 * One settings surface for the Order Engine service, three real sources:
 *   1. Paper engine prefs — POST /api/order-engine/settings →
 *      services.dummy_extras.update_prefs (slippage bps, order caps, start
 *      capital, auto-squareoff). Unknown keys are dropped server-side.
 *   2. Order Engine facade config — GET/PATCH /api/services/engines/
 *      order_engine/config (schema-bound, e.g. require broker confirmation).
 *   3. Mode-lock (terminal switching gate) — read-only status.
 *
 * Also shown read-only: the engine's fill-model truth (MKT slippage constant,
 * LMT tolerance, charge rates) — the same numbers the backend executes with.
 */
import { useCallback, useEffect, useState } from 'react';
import { Gauge, Lock, RefreshCw, Save, Settings2, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  OENG_TONE, fmtN,
} from '@/components/order-engine/oeng-shared';
import {
  getOrderEngineFacadeConfig,
  getOrderEngineSettings,
  saveOrderEngineSettings,
  updateOrderEngineFacadeConfig,
  type OrderEngineSettingsResponse,
} from '@/lib/api';

type IntField = 'slippageBps' | 'maxDailyOrders' | 'maxOrderValue' | 'startingCapital';

const PAPER_FIELDS: { key: IntField; label: string; help: string; min: number; max: number; step: number }[] = [
  { key: 'slippageBps', label: 'MKT slippage (bps)', help: 'Market order fill = real LTP ± this bps (0–100).', min: 0, max: 100, step: 1 },
  { key: 'maxDailyOrders', label: 'Max daily orders (0 = unlimited)', help: 'Daily order cap — 0 means no cap (native engine default).', min: 0, max: 100000, step: 1 },
  { key: 'maxOrderValue', label: 'Max order value (₹, 0 = off)', help: 'Single-order value cap — 0 means off.', min: 0, max: 100000000, step: 500 },
  { key: 'startingCapital', label: 'Session starting capital (₹)', help: 'Virtual balance a fresh IST day opens with.', min: 0, max: 1000000000, step: 1000 },
];

export default function OrderEngineSettingsPage() {
  const [settings, setSettings] = useState<OrderEngineSettingsResponse | null>(null);
  const [facade, setFacade] = useState<any>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<Partial<Record<IntField, string>>>({});
  const [saving, setSaving] = useState(false);
  const [facadeBusy, setFacadeBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [s, f] = await Promise.all([
        getOrderEngineSettings(),
        getOrderEngineFacadeConfig().catch(() => null),
      ]);
      setSettings(s);
      setFacade(f?.data ?? f ?? null);
      const prefs = s?.prefs ?? {};
      setForm({
        slippageBps: String(prefs.slippageBps ?? ''),
        maxDailyOrders: String(prefs.maxDailyOrders ?? ''),
        maxOrderValue: String(prefs.maxOrderValue ?? ''),
        startingCapital: String(prefs.startingCapital ?? ''),
      });
    } catch (exc: any) {
      setError(exc?.message ?? 'settings load failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyFacadeToggle = async (key: string, value: boolean) => {
    setFacadeBusy(true);
    try {
      const res = await updateOrderEngineFacadeConfig({ [key]: value });
      toast.success('Engine config saved', { description: `${key} → ${value}` });
      setFacade((res?.data ?? null));
    } catch (exc: any) {
      toast.error('Config save failed', { description: exc?.message ?? String(exc) });
    } finally {
      setFacadeBusy(false);
    }
  };

  const savePrefs = async (e: React.FormEvent) => {
    e.preventDefault();
    const updates: Record<string, unknown> = {};
    for (const f of PAPER_FIELDS) {
      const raw = form[f.key]?.trim() ?? '';
      if (raw === '') continue;
      const n = Number(raw);
      if (Number.isNaN(n) || n < f.min || n > f.max) {
        toast.error(`${f.label}: ${f.min}–${f.max} range me hona chahiye`);
        return;
      }
      updates[f.key] = f.step >= 1 ? Math.round(n) : n;
    }
    if (Object.keys(updates).length === 0) {
      toast.info('Kuch badalne ke liye edit karo pehle');
      return;
    }
    setSaving(true);
    try {
      const res = await saveOrderEngineSettings(updates);
      if (res?.ok === false) {
        toast.error('Prefs save failed', { description: String(res?.error ?? '') });
        return;
      }
      toast.success('Paper engine prefs saved', {
        description: `Slippage ${String(res?.prefs?.slippageBps ?? '—')} bps · caps applied live`,
      });
      await load();
    } catch (exc: any) {
      toast.error('Prefs save failed', { description: exc?.message ?? String(exc) });
    } finally {
      setSaving(false);
    }
  };

  const runtime = settings?.engineRuntime ?? {};
  const lock = settings?.modeLock ?? {};
  const model = settings?.paperModel ?? {};

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <section className="relative overflow-hidden rounded-2xl border border-rose-500/25 bg-gradient-to-br from-rose-500/[0.07] via-purple-500/[0.04] to-fuchsia-500/[0.07] shadow-sm">
        <div className="relative flex items-center gap-3 p-4 sm:p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-500 via-purple-500 to-fuchsia-600 text-white shadow-sm">
            <Settings2 className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Order Engine · Settings</h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              Paper engine prefs + engine runtime config — persisted backend settings
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void load()} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-700">
          Settings unavailable: {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* paper prefs */}
        <Card className={OENG_TONE.amber + ' shadow-sm'}>
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
              <SlidersHorizontal className="h-3.5 w-3.5" /> Paper engine · simulation prefs
              <Badge variant="outline" className="ml-auto font-mono">dummy_extras.update_prefs</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <form onSubmit={(e) => void savePrefs(e)} className="grid grid-cols-2 gap-2">
              {PAPER_FIELDS.map((f) => (
                <label key={f.key} className="col-span-2 text-[11px] sm:col-span-1">
                  <span className="font-semibold text-muted-foreground">{f.label}</span>
                  <input
                    type="number"
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={form[f.key] ?? ''}
                    onChange={(ev) => setForm((p) => ({ ...p, [f.key]: ev.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs"
                  />
                  <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">{f.help}</span>
                </label>
              ))}
              <label className="col-span-2 flex items-center justify-between rounded-lg border border-border bg-background px-2.5 py-2 text-[11px]">
                <span>
                  <span className="font-semibold">Auto square-off on target</span>
                  <span className="block text-[10px] text-muted-foreground">
                    Target hit hone par engine position reverse market order se close karta hai (current:{' '}
                    <span className="font-mono">{String(settings?.prefs?.autoSquareOffOnTarget ?? '—')}</span>)
                  </span>
                </span>
                <select
                  value={String(settings?.prefs?.autoSquareOffOnTarget !== false)}
                  onChange={(ev) => {
                    const next = String(ev.target.value) === 'true';
                    void (async () => {
                      setSaving(true);
                      try {
                        const res = await saveOrderEngineSettings({ autoSquareOffOnTarget: next });
                        toast.success('Auto square-off saved', { description: String(res?.prefs?.autoSquareOffOnTarget ?? next) });
                        await load();
                      } catch (exc: any) {
                        toast.error('Save failed', { description: exc?.message ?? String(exc) });
                      } finally {
                        setSaving(false);
                      }
                    })();
                  }}
                  className="ml-2 w-24 rounded-lg border border-input bg-background px-2 py-1 text-xs"
                  disabled={saving}
                >
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </select>
              </label>
              <div className="col-span-2 flex items-center gap-2">
                <Button type="submit" size="sm" className="gap-1.5 bg-gradient-to-r from-amber-500 to-orange-600" disabled={saving}>
                  <Save className="h-3.5 w-3.5" /> {saving ? 'Saving…' : 'Save prefs'}
                </Button>
                <span className="text-[10px] text-muted-foreground">Defaults restore karna ho to dummy terminal prefs page ya backend reset use karo.</span>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* facade config + runtime */}
        <div className="space-y-4">
          <Card className={OENG_TONE.emerald + ' shadow-sm'}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-xs">
                <ShieldCheck className="h-3.5 w-3.5" /> Engine runtime (facade)
                <Badge variant="outline" className="ml-auto font-mono">{String(runtime.state ?? '—')}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 pt-3 text-[11px]">
              {([
                ['Health', runtime.health ?? '—'],
                ['Managed', typeof runtime.managed === 'boolean' ? (runtime.managed ? 'YES (registry-managed)' : 'no') : '—'],
                ['Trading broker', runtime.metrics?.broker ?? '—'],
                ['Logged in', typeof runtime.metrics?.loggedIn === 'boolean' ? (runtime.metrics.loggedIn ? 'TRUE' : 'FALSE') : '—'],
                ['Connection', runtime.connectionState ?? '—'],
              ] as [string, string][]).map(([k, v]) => (
                <p key={k} className="flex items-center justify-between gap-2 rounded-lg border-b border-border/40 px-1.5 py-1">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="font-mono font-semibold">{v}</span>
                </p>
              ))}
              {runtime.error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-rose-700">{String(runtime.error)}</p>}
              <p className="text-[10px] leading-relaxed text-muted-foreground">Order Engine stateless choke-point hai — registry-managed, kabhi "stopped" concept nahi.</p>
            </CardContent>
          </Card>

          <Card className={OENG_TONE.sky + ' shadow-sm'}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-xs">
                <Gauge className="h-3.5 w-3.5" /> Engine config (schema-bound)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-3 text-[11px]">
              {(Array.isArray(facade?.fields) ? facade.fields : []).map((f: any, i: number) => (
                <div key={`${String(f?.key || f?.summary || f?.label || 'field')}-${i}`} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-2.5 py-1.5">
                  <span>
                    <span className="font-semibold">{String(f?.label ?? f?.key ?? '—')}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {String(f?.help ?? '')} {f?.editable === false ? '(read-only)' : ''}
                    </span>
                  </span>
                  {f?.editable !== false && f?.type === 'boolean' ? (
                    <select
                      disabled={facadeBusy}
                      value={String(f?.value ?? false)}
                      onChange={(ev) => void applyFacadeToggle(String(f.key), String(ev.target.value) === 'true')}
                      className="w-20 rounded-lg border border-input bg-background px-2 py-1 text-xs"
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <span className="font-mono">{String(f?.value ?? '—')}</span>
                  )}
                </div>
              ))}
              {!Array.isArray(facade?.fields) && <p className="text-muted-foreground">Engine config schema abhi load nahi hua.</p>}
            </CardContent>
          </Card>

          <Card className={OENG_TONE.violet + ' shadow-sm'}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-xs">
                <Lock className="h-3.5 w-3.5" /> Mode lock (terminal switching gate)
                <Badge variant="outline" className={lock.lockEnabled ? OENG_TONE.amber : OENG_TONE.emerald}>
                  {lock.lockEnabled ? 'LOCKED' : 'UNLOCKED'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-3 text-[11px]">
              <p className="text-muted-foreground">
                {lock.configured
                  ? `Configured via ${Array.isArray(lock.methods) && lock.methods.length ? lock.methods.join(' + ') : '—'} · webauthn ${lock.webauthnRegistered ? 'registered' : 'not registered'}.`
                  : 'Mode lock not configured (PIN/biometrics not set).'}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* fill-model truth */}
      <Card className={OENG_TONE.slate + ' shadow-sm'}>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">Backend fill-model truth (read-only — engine inhi par chalta hai)</CardTitle>
        </CardHeader>
        <CardContent className="pt-3 text-[11px]">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-border/60 bg-background px-2 py-1.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">MKT slippage</p>
              <p className="font-mono tabular-nums">{model.mktSlippage != null ? `${Number(model.mktSlippage * 100).toFixed(1)}%` : '—'}</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-background px-2 py-1.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">LMT tolerance</p>
              <p className="font-mono tabular-nums">{model.lmtTolerance != null ? `${Number(model.lmtTolerance * 100).toFixed(1)}%` : '—'}</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-background px-2 py-1.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Brokerage</p>
              <p className="font-mono tabular-nums">
                {fmtN(Number(model.charges?.brokerage ?? NaN))}
                <span className="text-muted-foreground"> / ₹ (×100 for %)</span>
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-background px-2 py-1.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">GST</p>
              <p className="font-mono tabular-nums">{fmtN(Number(model.charges?.gst ?? NaN))}</p>
            </div>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Ye constants engine ke execution decisions ka core hain (api/demo.py) — prefs me slippage bps inhe per-run override karta hai jab 0–100 valid range me ho.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
