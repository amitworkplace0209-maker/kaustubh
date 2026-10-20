'use client';

// Initializes the global custom theme at app root. When the active theme is
// 'custom' (or the user edits the palette), applies the stored CSS variables.
import { useEffect } from 'react';
import { useTheme } from 'next-themes';
import {
  applyCustomTheme,
  getCustomTheme,
  subscribeCustomTheme,
  type CustomThemePalette,
} from '@/lib/custom-theme';

export function CustomThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();

  useEffect(() => {
    // If 'custom' is freshly selected but never applied, emit current palette.
    if (theme === 'custom') applyCustomTheme(getCustomTheme());
    const unsub = subscribeCustomTheme(() => applyCustomTheme());
    return () => unsub();
  }, [theme]);

  return <>{children}</>;
}

export type { CustomThemePalette };
