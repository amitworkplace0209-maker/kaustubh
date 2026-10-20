'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2, Database, Monitor, RefreshCw, Save, Settings2, Server, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  PageHeader, SectionCard, SectionHeading, StatusBadge, LoadingState,
} from '@/components/design-system';

interface ConfigSection {
  id: string;
  title: string;
  icon: string;
  settings: ConfigSetting[];
}

interface ConfigSetting {
  key: string;
  label: string;
  description: string;
  type: 'boolean' | 'number' | 'string' | 'select';
  value: any;
  recommended?: any;
  options?: string[];
  min?: number;
  max?: number;
  unit?: string;
}

const SECTION_ICONS: Record<string, React.ElementType> = {
  collection: Settings2,
  storage: Database,
  processing: Server,
  performance: Monitor,
  ui: Monitor,
};

export default function Phase2ConfigurationPage() {
  const [loading, setLoading] = useState(true);
  const [sections, setSections] = useState<ConfigSection[]>([]);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/phase2/configuration');
      if (!res.ok) throw new Error('Failed');
      const d = await res.json();
      if (!mountedRef.current) return;
      setSections(d.sections ?? []);
      setLoading(false);
    } catch {
      if (!mountedRef.current) return;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const updateSetting = (sectionId: string, key: string, value: any) => {
    setSections((prev) => prev.map((s) => s.id === sectionId ? {
      ...s,
      settings: s.settings.map((st) => st.key === key ? { ...st, value } : st),
    } : s));
  };

  const saveSetting = async (sectionId: string, key: string) => {
    const setting = sections
      .find((s) => s.id === sectionId)
      ?.settings.find((st) => st.key === key);
    if (!setting) return;

    setSavingKeys((prev) => new Set(prev).add(`${sectionId}.${key}`));
    try {
      const res = await fetch('/api/phase2/configuration', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: setting.key, value: setting.value }),
      });
      if (res.ok) {
        setSavedKeys((prev) => new Set(prev).add(`${sectionId}.${key}`));
        setTimeout(() => {
          setSavedKeys((prev) => {
            const next = new Set(prev);
            next.delete(`${sectionId}.${key}`);
            return next;
          });
        }, 2000);
      }
    } catch {
      // leave current saved state
    } finally {
      setSavingKeys((prev) => {
        const next = new Set(prev);
        next.delete(`${sectionId}.${key}`);
        return next;
      });
    }
  };

  const resetSetting = (sectionId: string, setting: ConfigSetting) => {
    if (setting.recommended != null) {
      updateSetting(sectionId, setting.key, setting.recommended);
    }
  };

  const renderInput = (sectionId: string, setting: ConfigSetting) => {
    switch (setting.type) {
      case 'boolean':
        return (
          <Switch checked={setting.value} onCheckedChange={(v) => updateSetting(sectionId, setting.key, v)} />
        );
      case 'number':
        return (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={setting.min}
              max={setting.max}
              value={setting.value}
              onChange={(e) => updateSetting(sectionId, setting.key, parseFloat(e.target.value) || 0)}
              className="h-8 w-24 text-xs tabular-nums"
            />
            {setting.unit && <span className="text-[10px] text-muted-foreground">{setting.unit}</span>}
          </div>
        );
      case 'select':
        return (
          <select
            value={setting.value}
            onChange={(e) => updateSetting(sectionId, setting.key, e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            {setting.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        );
      case 'string':
      default:
        return (
          <Input
            value={setting.value}
            onChange={(e) => updateSetting(sectionId, setting.key, e.target.value)}
            className="h-8 w-48 text-xs"
          />
        );
    }
  };

  return (
    <div className="space-y-4 pb-2">
      <PageHeader title="Configuration" subtitle="System settings and preferences">
        <Button size="sm" variant="ghost" onClick={fetchData}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </PageHeader>

      {loading ? (
        <LoadingState text="Loading configuration..." />
      ) : sections.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">No configuration available</div>
      ) : (
        sections.map((section) => {
          const Icon = SECTION_ICONS[section.icon] || Settings2;
          return (
            <section key={section.id} aria-label={section.title} className="space-y-2">
              <SectionHeading>{section.title}</SectionHeading>
              <SectionCard title={section.title} icon={Icon}>
                <div className="space-y-4">
                  {section.settings.map((setting) => {
                    const isSaved = savedKeys.has(`${section.id}.${setting.key}`);
                    const hasRecommendation = setting.recommended != null && setting.recommended !== setting.value;
                    return (
                      <div key={setting.key} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-border/30 bg-card/30 px-3 py-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium">{setting.label}</p>
                            {isSaved && <StatusBadge status="success" label="Saved" />}
                            {hasRecommendation && <span className="text-[10px] text-orange-400">Recommended: {String(setting.recommended)}</span>}
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{setting.description}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {renderInput(section.id, setting)}
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => saveSetting(section.id, setting.key)} disabled={savingKeys.has(`${section.id}.${setting.key}`)}>
                            <Save className="h-3 w-3" />
                          </Button>
                          {hasRecommendation && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => resetSetting(section.id, setting)}>
                              <RefreshCw className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            </section>
          );
        })
      )}
    </div>
  );
}
