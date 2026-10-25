'use client';

// Per-product PWA identities: swaps the active <link rel="manifest"> and
// theme-color based on the current workspace path so each product installs
// as its own app opening at its own root.
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { usePhase2Theme, getPhase2ThemeStore } from '@/lib/phase2-theme';

const PRODUCT_MANIFESTS: { match: string; manifest: string; themeColor: string; appId: 'trading' | 'data-saver' | 'services' }[] = [
  { match: '/trading', manifest: '/manifest-trading.json', themeColor: '#059669', appId: 'trading' },
  { match: '/data-saver', manifest: '/manifest-data.json', themeColor: '#FF7849', appId: 'data-saver' },
  { match: '/services', manifest: '/manifest-services.json', themeColor: '#2563EB', appId: 'services' },
];

const DEFAULT_MANIFEST = '/manifest.json';
const DEFAULT_THEME_COLOR = '#060a08';

export function PWAIdentity() {
  const pathname = usePathname();
  // Subscribing to the theme store keeps the meta theme-color in sync with the
  // live accent whenever the user changes theme / brightness for the current app.
  const themeState = usePhase2Theme();

  useEffect(() => {
    const product = PRODUCT_MANIFESTS.find((p) => pathname.startsWith(p.match));
    const manifestHref = product?.manifest ?? DEFAULT_MANIFEST;

    // Resolve the effective primary colour for the ACTIVE product app so the
    // mobile browser chrome matches the chosen accent (light/dark aware).
    let themeColor = product?.themeColor ?? DEFAULT_THEME_COLOR;
    if (product) {
      try {
        const store = getPhase2ThemeStore();
        const appId = product.appId;
        const appState = store.getState(appId);
        const resolvedMode = store.getResolvedBrightness(appState) as 'light' | 'dark';
        const palette = store.resolvePalette(appState, resolvedMode);
        themeColor = palette.primary ?? product.themeColor;
        // hsl(...) values are valid for meta theme-color in modern browsers.
        if (themeColor.startsWith('hsl')) themeColor = cssHslToHex(themeColor) ?? product.themeColor;
      } catch {
        themeColor = product.themeColor;
      }
    }

    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    if (link.href !== manifestHref) link.href = manifestHref;

    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = themeColor;
  }, [pathname, themeState]);

  return null;
}

/** Convert an "H S% L%" (or hsla) colour string to a #rrggbb hex (best effort). */
function cssHslToHex(hsl: string): string | null {
  const m = hsl.match(/[\d.]+/g);
  if (!m || m.length < 3) return null;
  const h = +m[0];
  const s = Math.max(0, Math.min(100, +m[1])) / 100;
  const l = Math.max(0, Math.min(100, +m[2])) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to = (v: number) =>
    Math.round(Math.max(0, Math.min(255, f(v) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${to(0)}${to(8)}${to(4)}`;
}
