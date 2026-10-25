'use client';

import { useEffect, useState } from 'react';
import { Accessibility, Type } from 'lucide-react';
import { StatusBadge } from '@/components/design-system';
import { SettingsSectionBody } from '@/components/settings/settings-section-page';
import { getLocalSetting, setLocalSetting } from '@/lib/settings/store';

function A11yToggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[11px] text-muted-foreground">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-background shadow-sm transition-transform ${
            checked ? 'translate-x-[22px]' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

export default function AccessibilityPage() {
  const [systemReduced, setSystemReduced] = useState(false);
  const [reduceMotion, setReduceMotion] = useState<boolean>(() => getLocalSetting('ds-reduce-motion', false));
  const [highContrast, setHighContrast] = useState<boolean>(() => getLocalSetting('ds-high-contrast', false));
  const [textScale, setTextScale] = useState<number>(() => getLocalSetting('ds-text-scale', 100));

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setSystemReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setSystemReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--ds-motion', reduceMotion ? 'reduce' : 'default');
    setLocalSetting('ds-reduce-motion', reduceMotion);
  }, [reduceMotion]);

  useEffect(() => {
    document.documentElement.classList.toggle('ds-high-contrast', highContrast);
    setLocalSetting('ds-high-contrast', highContrast);
  }, [highContrast]);

  useEffect(() => {
    document.documentElement.style.setProperty('--ds-text-scale', `${textScale}%`);
    setLocalSetting('ds-text-scale', textScale);
  }, [textScale]);

  return (
    <SettingsSectionBody
      sectionId="accessibility"
      heroRight={<StatusBadge status={systemReduced ? 'info' : 'neutral'} label={systemReduced ? 'System prefers reduced motion' : 'Full motion'} />}
      extra={
        <div className="mt-4 space-y-4">
          <section className="rounded-xl border border-border bg-card">
            <header className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
              <Accessibility className="h-4 w-4 text-amber-500" />
              <p className="text-sm font-semibold">Motion & contrast</p>
            </header>
            <div className="divide-y divide-border/60 px-4">
              <A11yToggle
                checked={reduceMotion}
                onChange={setReduceMotion}
                label="Reduce motion"
                description="Disables non-essential animation and transitions across the app."
              />
              <A11yToggle
                checked={highContrast}
                onChange={setHighContrast}
                label="High contrast"
                description="Strengthens contrast for text, borders and status colours."
              />
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card">
            <header className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
              <Type className="h-4 w-4 text-amber-500" />
              <p className="text-sm font-semibold">Text scale</p>
            </header>
            <div className="px-4 py-4">
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">Small</span>
                <input
                  aria-label="Text scale"
                  type="range"
                  min={85}
                  max={140}
                  step={5}
                  value={textScale}
                  onChange={(e) => setTextScale(Number(e.target.value))}
                  className="flex-1 accent-amber-500"
                />
                <span className="text-xs text-muted-foreground">Large</span>
                <code className="w-12 rounded bg-muted px-1.5 py-0.5 text-center font-mono text-[11px]">{textScale}%</code>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Scales the base font applied to the whole interface. Preferences persist in your browser only.
              </p>
            </div>
          </section>
        </div>
      }
    />
  );
}