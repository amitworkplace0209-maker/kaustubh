'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  BellRing,
  Coins,
  Gauge,
  Loader2,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Timer,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import {
  getDummyPrefs,
  runDummyRetention,
  updateDummyPrefs,
  type DummyPrefs,
} from '@/lib/dummy';
import {
  Callout,
  FieldRow,
  NumberControl,
  Panel,
  Pill,
  SaveDot,
  SectionIntro,
  Segmented,
  SelectControl,
  ToggleRow,
  valuesEqual,
} from './settings-primitives';

const PRODUCTS = [
  { value: 'MIS', label: 'MIS (Intraday)' },
  { value: 'CNC', label: 'CNC (Delivery)' },
  { value: 'NRML', label: 'NRML' },
];

const ORDER_TYPES = [
  { value: 'MKT', label: 'Market' },
  { value: 'L', label: 'Limit' },
  { value: 'SL', label: 'SL' },
  { value: 'SL-M', label: 'SL-M' },
];

const BASKET_POLICIES = [
  { value: 'ALL_OR_NONE', label: 'All or none' },
  { value: 'BEST_EFFORT', label: 'Best effort' },
];

export function DummyPanel() {
  const { toast } = useToast();
  const [prefs, setPrefs] = useState<DummyPrefs | null>(null);
  const [savedPrefs, setSavedPrefs] = useState<DummyPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [purgeDays, setPurgeDays] = useState(7);
  const [purging, setPurging] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getDummyPrefs();
      const next = res?.prefs ?? null;
      setPrefs(next);
      setSavedPrefs(next ? structuredClone(next) : null);
      if (next?.retentionDays) setPurgeDays(next.retentionDays);
    } catch {
      setPrefs(null);
      setSavedPrefs(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = Boolean(prefs && savedPrefs && !valuesEqual(prefs, savedPrefs));

  const patch = (next: Partial<DummyPrefs>) => setPrefs((prev) => (prev ? { ...prev, ...next } : prev));

  const patchDelivery = (key: keyof DummyPrefs['notificationDelivery'], value: boolean) => {
    setPrefs((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        notificationDelivery: {
          ...(prev.notificationDelivery ?? { inApp: true, popup: false, sound: false, push: false }),
          [key]: value,
        },
      };
    });
  };

  const save = async () => {
    if (!prefs) return;
    setSaveState('saving');
    try {
      await updateDummyPrefs({
        ...prefs,
        autoRefreshMs: Math.max(1500, Number(prefs.autoRefreshMs) || 1500),
        alertCooldownSec: Math.max(0, Number(prefs.alertCooldownSec) || 0),
        slippageBps: Math.max(0, Math.min(200, Number(prefs.slippageBps) || 0)),
        maxDailyOrders: Math.max(0, Number(prefs.maxDailyOrders) || 0),
        maxOrderValue: Math.max(0, Number(prefs.maxOrderValue) || 0),
        retentionDays: Math.max(1, Math.min(30, Number(prefs.retentionDays) || 7)),
        notificationDelivery: {
          inApp: Boolean(prefs.notificationDelivery?.inApp),
          popup: Boolean(prefs.notificationDelivery?.popup),
          sound: Boolean(prefs.notificationDelivery?.sound),
          push: Boolean(prefs.notificationDelivery?.push),
        },
      });
      setSaveState('saved');
      setSavedPrefs(structuredClone(prefs));
      toast({ title: 'Dummy simulation preferences saved' });
      window.setTimeout(() => setSaveState('idle'), 1800);
    } catch (err) {
      setSaveState('error');
      toast({
        title: 'Could not save dummy preferences',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const purge = async () => {
    setPurging(true);
    try {
      const res = await runDummyRetention(purgeDays);
      const removed = res?.removed ?? res?.deleted ?? res?.count;
      toast({
        title: 'Retention run complete',
        description:
          typeof removed === 'number'
            ? `${removed} record(s) older than ${purgeDays} day(s) removed.`
            : `History older than ${purgeDays} day(s) was purged.`,
      });
    } catch (err) {
      toast({
        title: 'Retention run failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setPurging(false);
    }
  };

  if (loading) {
    return (
      <Panel>
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading simulation engine preferences…
        </div>
      </Panel>
    );
  }

  if (!prefs) {
    return (
      <div className="space-y-4">
        <SectionIntro
          eyebrow="Dummy engine"
          title="Simulation"
          description="Preferences for the server-side paper trading engine."
        />
        <Callout tone="danger" title="Dummy engine unreachable">
          The simulation preferences endpoint did not respond. Check that the Python service is running.
        </Callout>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={load}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionIntro
        eyebrow="Dummy engine"
        title="Simulation"
        description="Tune the paper-trading engine: fill behaviour, cooldowns, guard rails and notification delivery. These settings only affect Dummy mode."
        actions={
          <>
            <SaveDot state={saveState} />
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={load}
              disabled={saveState === 'saving'}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reload
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={save} disabled={!dirty || saveState === 'saving'}>
              {saveState === 'saving' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-3.5 w-3.5" />
              )}
              Save {dirty ? 'changes' : ''}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Execution" description="How simulated orders are generated and filled." icon={SlidersHorizontal}>
          <FieldRow label="Refresh interval" description="UI polling cadence while the dummy engine is active.">
            <NumberControl
              value={prefs.autoRefreshMs}
              onChange={(v) => patch({ autoRefreshMs: v })}
              min={1500}
              max={60000}
              step={500}
              unit="ms"
              width="w-24"
            />
          </FieldRow>
          <FieldRow label="Default product" description="Product type pre-selected on the order form.">
            <SelectControl
              value={prefs.defaultProduct}
              onChange={(v) => patch({ defaultProduct: v })}
              options={PRODUCTS}
              width="w-36"
            />
          </FieldRow>
          <FieldRow label="Default order type" description="Order type pre-selected on the order form.">
            <SelectControl
              value={prefs.defaultOrderType}
              onChange={(v) => patch({ defaultOrderType: v })}
              options={ORDER_TYPES}
              width="w-32"
            />
          </FieldRow>
          <FieldRow label="Slippage" description="Adverse price movement applied to simulated fills.">
            <NumberControl
              value={prefs.slippageBps}
              onChange={(v) => patch({ slippageBps: v })}
              min={0}
              max={200}
              step={1}
              unit="bps"
              width="w-20"
            />
          </FieldRow>
          <FieldRow label="Basket policy" description="How a partially-fillable basket is handled.">
            <Segmented
              value={prefs.defaultBasketPolicy}
              onChange={(v) => patch({ defaultBasketPolicy: v })}
              options={BASKET_POLICIES}
            />
          </FieldRow>
          <ToggleRow
            label="Confirm basket execution"
            description="Ask before executing a multi-leg dummy basket."
            checked={prefs.confirmBasketExecute}
            onChange={(v) => patch({ confirmBasketExecute: v })}
          />
        </Panel>

        <Panel title="Guard rails" description="Hard limits applied by the dummy risk engine." icon={Gauge}>
          <FieldRow label="Max order value" description="Largest single simulated order (virtual coins).">
            <NumberControl
              value={prefs.maxOrderValue}
              onChange={(v) => patch({ maxOrderValue: v })}
              min={0}
              step={1000}
              prefix="₹"
              width="w-28"
            />
          </FieldRow>
          <FieldRow label="Max daily orders" description="Zero means unlimited.">
            <NumberControl
              value={prefs.maxDailyOrders}
              onChange={(v) => patch({ maxDailyOrders: v })}
              min={0}
              step={1}
              width="w-20"
            />
          </FieldRow>
          <ToggleRow
            label="Auto square-off on target"
            description="Close the dummy position as soon as its target is hit."
            checked={prefs.autoSquareOffOnTarget}
            onChange={(v) => patch({ autoSquareOffOnTarget: v })}
          />
          <FieldRow label="Alert cooldown" description="Minimum gap between repeated dummy alerts.">
            <NumberControl
              value={prefs.alertCooldownSec}
              onChange={(v) => patch({ alertCooldownSec: v })}
              min={0}
              max={3600}
              step={5}
              unit="s"
              width="w-20"
            />
          </FieldRow>
          <FieldRow label="Retention window" description="Dummy ticks and history are pruned after this window.">
            <NumberControl
              value={prefs.retentionDays}
              onChange={(v) => patch({ retentionDays: v })}
              min={1}
              max={30}
              step={1}
              unit="d"
              width="w-20"
            />
          </FieldRow>
        </Panel>
      </div>

      <Panel title="Notification delivery" description="Channels used by the dummy engine for simulation events." icon={BellRing}>
        <div className="grid gap-x-8 sm:grid-cols-2">
          <ToggleRow
            label="In-app feed"
            description="Show dummy order and trigger events in the notification centre."
            checked={Boolean(prefs.notificationDelivery?.inApp)}
            onChange={(v) => patchDelivery('inApp', v)}
          />
          <ToggleRow
            label="Browser popup"
            description="Desktop notification when the tab is in the background."
            checked={Boolean(prefs.notificationDelivery?.popup)}
            onChange={(v) => patchDelivery('popup', v)}
          />
          <ToggleRow
            label="Sound cues"
            description="Play a sound on fill, target and stop-loss events."
            checked={Boolean(prefs.notificationDelivery?.sound)}
            onChange={(v) => patchDelivery('sound', v)}
          />
          <ToggleRow
            label="Push notifications"
            description="Deliver to registered PWA devices."
            checked={Boolean(prefs.notificationDelivery?.push)}
            onChange={(v) => patchDelivery('push', v)}
          />
        </div>
      </Panel>

      <Panel
        title="Maintenance"
        description="Purge old simulation history without touching the current virtual account."
        icon={Trash2}
        actions={<Pill tone="warning" dot>destructive</Pill>}
      >
        <FieldRow
          label="Retention cutoff"
          description="Remove dummy orders, positions and ticks older than this many days."
        >
          <NumberControl
            value={purgeDays}
            onChange={setPurgeDays}
            min={1}
            max={30}
            step={1}
            unit="d"
            width="w-20"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={purge}
            disabled={purging}
          >
            {purging ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Timer className="mr-1.5 h-3.5 w-3.5" />}
            Run retention
          </Button>
        </FieldRow>
        <Callout tone="neutral" icon={Coins} className="mt-2">
          This keeps the virtual account, open positions and the current trading day intact.
        </Callout>
      </Panel>
    </div>
  );
}
