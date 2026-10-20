'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TERMINAL_ROUTES, type TerminalMode } from '@/components/layout/nav';
import { useTradingMode } from '@/lib/settings-store';

/**
 * Terminal-aware route scope. Every /trading/{page} is gated so the active
 * terminal's registry (TERMINAL_ROUTES in nav.ts) decides what renders:
 * - the current mode is NOT in the route's `allowed` set -> redirect to the
 *   terminal dashboard (router.replace, no reload),
 * - otherwise the page renders as usual.
 * This is what guarantees a Dummy user can never reach the Kotak-order UI (or
 * vice versa) and Shoonya only exposes its honest, implemented surface.
 */
export function TerminalRouteGate({
  path,
  allowed,
  children,
}: {
  path: string;
  allowed: readonly TerminalMode[];
  children: React.ReactNode;
}) {
  const mode = useTradingMode();
  const router = useRouter();
  const registered = TERMINAL_ROUTES[mode];
  const ok = (registered ?? []).includes(path) && allowed.includes(mode);

  useEffect(() => {
    if (!ok) router.replace('/trading/dashboard');
  }, [ok, router]);

  if (!ok) return null;
  return <>{children}</>;
}