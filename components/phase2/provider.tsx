'use client'

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { getAppByPath, type AppId } from '@/lib/apps'
import { useTradingMode } from '@/lib/settings-store'
import {
  applyPhase2Theme,
  getPhase2ThemeState,
  getPhase2ThemeStore,
} from '@/lib/phase2-theme'

const STORAGE_KEY = 'phase2_sidebar_collapsed'

interface Phase2ContextValue {
  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean) => void
  toggleSidebar: () => void
}

const Phase2Context = createContext<Phase2ContextValue | null>(null)

/**
 * PhaseProvider — global, route-derived phase identity + sidebar state.
 *
 * Lives at the ROOT (inside AppProviders) so it never remounts on route
 * navigation. The active KAUSTUBH phase is derived from the current pathname
 * (authoritative, same rule the phase switcher uses); the trading workspace
 * additionally scopes theme/settings state to the active terminal
 * (KOTAK NEO / DUMMY / SHOONYA) so each terminal keeps its own theme.
 * Syncing to the theme engine happens in an effect (no page reload).
 */
export function PhaseProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const tradingMode = useTradingMode()
  const app: AppId = getAppByPath(pathname ?? '/')
  const scope = app === 'trading' ? tradingMode : null

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(sidebarCollapsed))
    } catch {}
  }, [sidebarCollapsed])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev)
  }, [])

  // Keep the theme engine's active app + terminal scope in sync with the route
  // (idempotent; applies the scoped theme without any reload).
  useEffect(() => {
    const store = getPhase2ThemeStore()
    if (store.getCurrentApp() !== app || store.getCurrentScope() !== scope) {
      store.setCurrentApp(app, scope)
    }
    applyPhase2Theme(getPhase2ThemeState())
  }, [app, scope])

  return (
    <Phase2Context.Provider value={{ sidebarCollapsed, setSidebarCollapsed, toggleSidebar }}>
      {children}
    </Phase2Context.Provider>
  )
}

/** Backwards-compatible alias (the two providers are the same implementation). */
export const Phase2Provider = PhaseProvider

export function usePhase2(): Phase2ContextValue {
  const ctx = useContext(Phase2Context)
  if (!ctx) throw new Error('usePhase2 must be used within a PhaseProvider')
  return ctx
}