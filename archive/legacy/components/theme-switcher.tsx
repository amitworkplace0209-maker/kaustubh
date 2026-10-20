'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun, Paintbrush } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  applyCustomTheme,
  getCustomTheme,
  PRESET_LABELS,
  subscribeCustomTheme,
  type CustomThemePalette,
} from '@/lib/custom-theme';

interface ThemeSwitcherProps {
  className?: string;
}

const themes = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'amoled', label: 'AMOLED', icon: 'amoled' },
  { id: 'custom', label: 'Custom', icon: Paintbrush },
] as const;

function AmoledIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}

function ThemeGlyph({ id, className }: { id: string; className?: string }) {
  if (id === 'amoled') return <AmoledIcon className={className} />;
  if (id === 'dark') return <Moon className={className} />;
  if (id === 'light') return <Sun className={className} />;
  return <Paintbrush className={className} />;
}

const EDITABLE_KEYS: (keyof CustomThemePalette)[] = [
  'background', 'card', 'foreground', 'primary', 'accent', 'border', 'mutedForeground',
];

export function ThemeSwitcher({ className }: ThemeSwitcherProps) {
  const { theme, setTheme } = useTheme();
  const [, bump] = useState(0);
  useEffect(() => subscribeCustomTheme(() => bump((v) => v + 1)), []);
  const palette = getCustomTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-8 w-8 p-0 text-white/40 hover:text-white', className)}
          aria-label="Change theme"
        >
          <ThemeGlyph id={theme ?? 'light'} className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {themes.map((t) => {
          const isActive = theme === t.id;
          return (
            <DropdownMenuItem
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={cn(
                'flex items-center gap-2 cursor-pointer text-sm',
                isActive && 'font-semibold',
              )}
            >
              <ThemeGlyph id={t.id} className="h-3.5 w-3.5" />
              <span>{t.label}</span>
              {isActive && <span className="ml-auto text-primary">&#10003;</span>}
            </DropdownMenuItem>
          );
        })}

        {theme === 'custom' && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Custom palette
              </p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {EDITABLE_KEYS.map((key) => (
                  <label key={key} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <input
                      type="color"
                      className="h-5 w-6 shrink-0 cursor-pointer rounded border border-border bg-transparent"
                      value={toHex(palette[key])}
                      onChange={(e) => applyCustomTheme({ [key]: toHsl(e.target.value) })}
                    />
                    <span className="truncate">{PRESET_LABELS[key]}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function isHslTuple(v: unknown): v is string {
  return typeof v === 'string' && v.split(' ').length === 3;
}

function toHex(hsl: string): string {
  if (!isHslTuple(hsl)) return '#3b82f6';
  const [h, s, l] = hsl.split(' ').map((n) => parseFloat(n));
  return hslToHex(h, s / 100, l / 100);
}

function toHsl(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const hsv = rgbToHsl(r, g, b);
  return `${Math.round(hsv.h)} ${Math.round(hsv.s * 100)}% ${Math.round(hsv.l * 100)}%`;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l };
}
