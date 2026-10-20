'use client';

import { ThemeProvider } from '@/components/layout/theme-provider';
import { AuthProvider } from '@/components/auth-provider';
import { PhaseProvider } from '@/components/phase2/provider';
import { TerminalProvider } from '@/components/terminal/terminal-provider';
import { TerminalModeReconciler } from '@/components/terminal/mode-reconciler';
import { RealtimeProvider } from '@/components/realtime-provider';
import { FrontendRealtimeProvider } from '@/components/frontend-realtime-provider';
import { DesktopNotifier } from '@/components/desktop-notifier';
import { SystemProvider } from '@/components/system-provider';
import { SessionSyncProvider } from '@/components/session-sync-provider';
import { SettingsBootstrap } from '@/components/settings-bootstrap';

/**
 * AppProviders — the single root provider tree mounted once in app/layout.tsx.
 *
*  AppProviders
 *    ├── ThemeProvider        (applies the active app/scope palette; no reload)
 *    ├── AuthProvider         (the ONE Next-layer session source — feeds the
 *    │                         realtime client gating; no reload hacks)
 *    ├── PhaseProvider        (route-derived phase identity + sidebar state)
 *    ├── TerminalProvider     (global TerminalContext: DUMMY/KOTAK/SHOONYA)
 *    ├── RealtimeProvider     (the ONE centralized backend SSE bridge)
 *    ├── FrontendRealtimeProvider (the ONE backend⇄frontend WebSocket #2,
 *    │                         realtime market/event frames; SSE falls back)
 *    ├── SessionSyncProvider  (the ONE central session countdown — backend
 *    │                         expiresAt; survives navigation + refresh)
 *    ├── SystemProvider       (the ONE centralized /api/system poll — every
 *    │                         phase shares it; feeds the topbar refresh)
 *    ├── DesktopNotifier      (turns real backend incidents into OS/browser
 *    │                         notifications, deduped + severity-gated)
 *    └── SettingsBootstrap    (loads persisted prefs once at startup)
 *
 * These never remount on ordinary route navigation, so no duplicate sockets or
 * poll loops are ever created. DataSaverProvider stays scoped to its own route
 * segment ((phase2) layout) — it owns a single poll for the dashboard aggregate
 * and is intentionally NOT mounted for other phases.
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <PhaseProvider>
          <TerminalProvider>
            <RealtimeProvider>
              <FrontendRealtimeProvider>
                <SessionSyncProvider>
                  <SettingsBootstrap>
                    <SystemProvider>
                      <DesktopNotifier />
                      <TerminalModeReconciler />
                      {children}
                    </SystemProvider>
                  </SettingsBootstrap>
                </SessionSyncProvider>
              </FrontendRealtimeProvider>
            </RealtimeProvider>
          </TerminalProvider>
        </PhaseProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}