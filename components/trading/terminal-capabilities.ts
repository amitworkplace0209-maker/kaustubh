'use client';

/**
 * Live terminal capabilities — read from the BACKEND capability registry.
 *
 * The trade page must only offer what the active broker's SDK actually
 * supports (order types, products, a real margin API, a depth ladder, a
 * charge model). Those facts are owned by the backend registry
 * (`python-service/brokers/capabilities.py`) and served at
 * `GET /api/terminal/list`.
 *
 * This hook fetches that registry ONCE per terminal and hands the page a
 * `TradeCapabilities` object. Until the fetch lands the static mirror
 * (`capsFor`) is used, so the UI never renders an empty control set.
 *
 * No capability is ever invented here: an unknown field keeps the static
 * mirror's value.
 */

import { useEffect, useMemo, useState } from 'react';
import { getTerminalList, type TerminalId } from '@/lib/terminal-service';
import { capsFor, capsFromBackend, type TradeCapabilities } from '@/components/orders/trade/capabilities';

export interface TerminalCapabilitiesState {
  caps: TradeCapabilities;
  /** True while the live registry is still being fetched. */
  loading: boolean;
  /** 'backend' when the live registry answered, 'mirror' while falling back. */
  source: 'backend' | 'mirror';
  /** The terminal the backend reported as ACTIVE (may differ from the page's). */
  activeTerminal: TerminalId | null;
}

export function useTerminalCapabilities(terminal: TerminalId): TerminalCapabilitiesState {
  const mirror = useMemo(() => capsFor(terminal), [terminal]);
  const [live, setLive] = useState<TradeCapabilities | null>(null);
  const [activeTerminal, setActiveTerminal] = useState<TerminalId | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTerminalList()
      .then((res) => {
        if (cancelled) return;
        const terminals = Array.isArray(res?.terminals) ? res.terminals : [];
        const match = terminals.find((t) => t?.id === terminal) as
          | (Record<string, any> & { id: string })
          | undefined;
        const active = terminals.find((t) => t?.active) as
          | (Record<string, any> & { id: string })
          | undefined;
        setActiveTerminal((active?.id as TerminalId) ?? null);
        if (match?.capabilities) setLive(capsFromBackend(terminal, match.capabilities));
      })
      .catch(() => {
        if (!cancelled) setLive(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [terminal]);

  return {
    caps: live ?? mirror,
    loading,
    source: live ? 'backend' : 'mirror',
    activeTerminal,
  };
}
