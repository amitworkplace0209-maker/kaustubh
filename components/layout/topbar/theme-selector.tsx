'use client';

import { useState } from 'react';
import { Check, Moon, Monitor, Sun, Smartphone, Palette, Pipette } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  usePhase2Theme,
  setPhase2Brightness,
  setAccentPreset,
  setCustomAccentColor,
  ACCENT_PRESETS,
  DEFAULT_ACCENT_PRESET_ID,
  cssToHex,
  type Phase2Brightness,
} from '@/lib/phase2-theme';
import { cn } from '@/lib/utils';

const BRIGHTNESS: { value: Phase2Brightness; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'amoled', label: 'AMOLED', icon: Smartphone },
];

export function ThemeSelector() {
  const theme = usePhase2Theme();
  const [open, setOpen] = useState(false);

  const activeAccentHex = theme.overrides?.accent ? cssToHex(String(theme.overrides.accent)) : null;
  const activePreset = ACCENT_PRESETS.find((p) => activeAccentHex && mathHex(p.hex) === mathHex(activeAccentHex));
  const CurrentIcon = BRIGHTNESS.find((b) => b.value === theme.brightness)?.icon ?? Monitor;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild onMouseDown={(e) => e.preventDefault()}>
        <button
          type="button"
          aria-label={`Theme: ${theme.brightness}`}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:h-9 lg:w-9"
        >
          <CurrentIcon className="size-[18px]" aria-hidden />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-[min(92vw,300px)] p-0">
        <div className="rounded-lg border bg-popover/95 backdrop-blur-sm">
          <div className="border-b border-border/60 px-3 py-2.5">
            <p className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <Palette className="size-4 text-muted-foreground" aria-hidden />
              Appearance
            </p>
          </div>

          <div className="grid grid-cols-4 gap-1.5 p-3">
            {BRIGHTNESS.map(({ value, label, icon: Icon }) => {
              const active = theme.brightness === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPhase2Brightness(value)}
                  aria-pressed={active}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[10px] font-medium transition-colors',
                    active
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-border/60 text-muted-foreground hover:bg-accent',
                  )}
                >
                  <Icon className={cn('size-4', active && 'text-primary')} aria-hidden />
                  {label}
                </button>
              );
            })}
          </div>

          <div className="border-t border-border/60 p-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Accent color
            </p>
            <div className="flex items-center gap-1.5">
              {ACCENT_PRESETS.map((p) => {
                const active = activePreset?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setAccentPreset(p.id)}
                    aria-label={`Accent ${p.name}`}
                    aria-pressed={active}
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-full border border-border/60 transition-transform hover:scale-110',
                      active && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
                    )}
                    style={{ backgroundColor: p.hex }}
                  >
                    {active && <Check className="size-3.5 text-white drop-shadow" aria-hidden />}
                  </button>
                );
              })}
              <label
                title="Custom accent"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent"
              >
                <Pipette className="size-3.5" aria-hidden />
                <input
                  type="color"
                  aria-label="Custom accent color"
                  value={activeAccentHex ?? ACCENT_PRESETS.find((p) => p.id === DEFAULT_ACCENT_PRESET_ID)!.hex}
                  onChange={(e) => setCustomAccentColor(e.target.value)}
                  className="absolute size-0 cursor-pointer opacity-0"
                />
              </label>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function mathHex(hex: string): string {
  return hex.replace('#', '').toUpperCase();
}