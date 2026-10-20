'use client';

import { useEffect, useState } from 'react';
import { Target, Plus, Trash2, Flag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TradeCapabilities } from '@/components/orders/trade/capabilities';

interface TargetPanelProps {
  mode: string;
  caps: TradeCapabilities;
  symbol: string | undefined;
  loggedIn: boolean;
}

export function TargetPanel({ mode, caps, symbol, loggedIn }: TargetPanelProps) {
  const [targets, setTargets] = useState<Array<{ symbol: string; value: number; current?: number; achieved?: boolean }>>([]);
  const [loading, setLoading] = useState(false);
  const [newTarget, setNewTarget] = useState('');
  const isDemo = caps.virtualCurrency;
  const unit = isDemo ? 'C' : '₹';

  useEffect(() => {
    if (!symbol || !loggedIn) { setTargets([]); return; }
    // In a real app, this would fetch from the backend
    // For now, we'll use localStorage for demo targets
    try {
      const stored = localStorage.getItem(`targets_${mode}`);
      if (stored) setTargets(JSON.parse(stored).filter((t: any) => t.symbol === symbol));
    } catch {}
  }, [symbol, mode, loggedIn]);

  const saveTargets = (updated: typeof targets) => {
    try {
      const stored = localStorage.getItem(`targets_${mode}`);
      const all = stored ? JSON.parse(stored) : [];
      const filtered = all.filter((t: any) => t.symbol !== symbol);
      localStorage.setItem(`targets_${mode}`, JSON.stringify([...filtered, ...updated]));
    } catch {}
  };

  const handleAdd = () => {
    const value = parseFloat(newTarget);
    if (!symbol || isNaN(value) || value <= 0) return;
    const updated = [...targets, { symbol, value }];
    setTargets(updated);
    saveTargets(updated);
    setNewTarget('');
  };

  const handleRemove = (value: number) => {
    const updated = targets.filter(t => t.value !== value);
    setTargets(updated);
    saveTargets(updated);
  };

  if (!symbol || !loggedIn) {
    return <p className="text-[11px] text-muted-foreground text-center py-4">Select a stock and sign in to set targets</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Input value={newTarget} onChange={e => setNewTarget(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} placeholder={`Target ${unit}`} className="h-9 w-24 text-[12px] font-mono tabular-nums" inputMode="decimal" step="0.05" min="0" />
        <Button size="sm" className="h-9" onClick={handleAdd} disabled={!newTarget || parseFloat(newTarget) <= 0}><Plus className="h-3.5 w-3.5" /></Button>
      </div>

      {targets.length === 0 ? (
        <p className="text-[11px] text-muted-foreground text-center py-2">No targets set. Add a target price above.</p>
      ) : (
        <div className="space-y-1 max-h-40 overflow-auto">
          {targets.map((t, i) => (
            <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-muted/30 px-2 py-1.5 text-[10px]">
              <span className="flex items-center gap-1.5">
                <Flag className="h-3.5 w-3.5 text-primary" />
                <span className="font-mono font-bold tabular-nums">{unit}{t.value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </span>
              <Button variant="ghost" size="sm" className="h-7 p-0" onClick={() => handleRemove(t.value)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}