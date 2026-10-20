'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, Save } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  PageHeader, SectionCard, SectionHeading, LoadingState, ErrorState, StatusBadge,
} from '@/components/design-system';

interface SettingItem {
  key: string; value: unknown; description: string; masked: boolean; updatedAt?: string | null;
}
interface SettingSection { id: string; label: string; settings: SettingItem[] }
interface SettingsResponse { sections: SettingSection[] }

function fmtTs(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
}

const valueIsBool = (v: unknown) => typeof v === 'boolean';
const valueIsNum = (v: unknown) => typeof v === 'number';
const valueIsStr = (v: unknown) => typeof v === 'string';

export default function FormatSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [availableFormats, setAvailableFormats] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sRes, fRes] = await Promise.all([
        fetch(`/api/phase2/formats/settings?t=${Date.now()}`),
        fetch(`/api/phase2/formats?t=${Date.now()}`),
      ]);
      const s = await sRes.json();
      const f = await fRes.json();
      setSettings(s);
      const init: Record<string, unknown> = {};
      for (const sec of s?.sections ?? []) {
        for (const item of sec.settings ?? []) {
          init[item.key] = item.value;
        }
      }
      setDraft(init);
      setAvailableFormats((f?.formats ?? [])
        .filter((x: { available?: boolean }) => x.available !== false)
        .map((x: { id: string }) => x.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load format settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setValue = (key: string, v: unknown) => setDraft((d) => ({ ...d, [key]: v }));

  const save = async () => {
    setSaving(true);
    setSavedMsg(null);
    setSaveError(null);
    try {
      const changes = Object.entries(draft).map(([key, value]) => ({ key, value }));
      const res = await fetch('/api/phase2/formats/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: changes }),
      });
      const body = await res.json();
      if (!res.ok) {
        const err = body?.error ?? body?.detail ?? 'Save failed';
        setSaveError(typeof err === 'string' ? err : JSON.stringify(err));
      } else {
        setSavedMsg('Settings saved and persisted.');
        await load();
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save request failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState text="Loading format settings..." />;
  if (error) {
    return (
      <div className="space-y-4 pb-2">
        <PageHeader title="Format Settings" subtitle="Configure export formats" />
        <ErrorState message={error} onRetry={() => { setError(null); load(); }} />
      </div>
    );
  }

  const sections = settings?.sections ?? [];

  const renderControl = (item: SettingItem) => {
    const v = draft[item.key];
    if (valueIsBool(v)) {
      return (
        <div className="flex items-center gap-2">
          <Switch checked={Boolean(v)} onCheckedChange={(c) => setValue(item.key, c)} disabled={item.masked} />
          <span className="text-[11px] text-muted-foreground">{v ? 'Enabled' : 'Disabled'}</span>
        </div>
      );
    }
    if (valueIsNum(v)) {
      return (
        <Input
          type="number"
          value={String(v)}
          onChange={(e) => setValue(item.key, e.target.value === '' ? 0 : Number(e.target.value))}
          disabled={item.masked}
          className="h-9 w-32 text-xs"
        />
      );
    }
    if (item.key === 'download_default_format' && Array.isArray(v)) {
      return (
        <Select value={String(v)} onValueChange={(val) => setValue(item.key, val)} disabled={item.masked || availableFormats.length === 0}>
          <SelectTrigger className="h-9 w-40 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {availableFormats.map((f) => (
              <SelectItem key={f} value={f}>{f}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    return (
      <Input
        value={typeof v === 'string' ? v : String(v ?? '')}
        onChange={(e) => setValue(item.key, e.target.value)}
        disabled={item.masked}
        className="h-9 w-56 text-xs"
      />
    );
  };

  return (
    <div className="space-y-4 pb-2">
      <PageHeader title="Format Settings" subtitle="Real persisted output and collection configuration">
        <Button asChild size="sm" variant="ghost">
          <Link href="/data-saver/formats"><ArrowLeft className="h-3.5 w-3.5" /> Formats</Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={load} disabled={saving}>
          <RefreshCw className={`h-4 w-4 ${saving ? 'animate-spin' : ''}`} />
        </Button>
      </PageHeader>

      {savedMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          <StatusBadge status="success" label="Saved" /> {savedMsg}
        </div>
      )}
      {saveError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Save failed: {saveError}
        </div>
      )}

      {sections.map((sec) => (
        <section key={sec.id} aria-label={sec.label} className="space-y-2">
          <SectionHeading>{sec.label}</SectionHeading>
          <SectionCard title={sec.label}>
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              {sec.settings.map((item) => (
                <div key={item.key} className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground">{item.key.replace(/_/g, ' ')}</label>
                    {item.masked && <StatusBadge status="neutral" label="masked" />}
                  </div>
                  <div>{renderControl(item)}</div>
                  {item.description && <p className="text-[10px] text-muted-foreground/70">{item.description}</p>}
                </div>
              ))}
            </div>
          </SectionCard>
        </section>
      ))}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button size="sm" variant="outline" onClick={load} disabled={saving}>
          <RefreshCw className="h-3.5 w-3.5" /> Discard
        </Button>
        <Button size="sm" onClick={save} disabled={saving}>
          <Save className="h-3.5 w-3.5" /> {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>
    </div>
  );
}
