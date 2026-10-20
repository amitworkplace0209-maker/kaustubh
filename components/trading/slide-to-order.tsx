'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OrderSide } from '@/components/orders/trade/types';

const COMMIT_RATIO = 0.82;

function vibrate(pattern: number | number[]) {
  try { if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(pattern); } catch {}
}

export function SlideToOrder({
  side, label, disabled, placing, swipe, onConfirm, className,
}: { side: OrderSide; label: string; disabled?: boolean; placing?: boolean; swipe?: boolean; onConfirm: () => void; className?: string }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; max: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [ratio, setRatio] = useState(0);

  const isBuy = side === 'BUY';
  const SideIcon = isBuy ? TrendingUp : TrendingDown;

  const maxTravel = useCallback(() => {
    const track = trackRef.current;
    const knob = knobRef.current;
    if (!track || !knob) return 0;
    return Math.max(0, track.clientWidth - knob.offsetWidth - 8);
  }, []);

  const reset = useCallback(() => { dragRef.current = null; setOffset(0); setRatio(0); setDragging(false); }, []);

  const commit = useCallback(() => {
    if (disabled || placing) return;
    dragRef.current = null; setRatio(1); vibrate([12, 40, 18]);
    setTimeout(() => { setDragging(false); onConfirm(); }, 130);
    setTimeout(reset, 420);
  }, [disabled, placing, onConfirm, reset]);

  useEffect(() => {
    const onResize = () => { if (!dragging) return; setOffset(o => Math.min(o, maxTravel())); };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('orientationchange', onResize); };
  }, [dragging, maxTravel]);

  useEffect(() => { if (!dragging) return; const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') reset(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [dragging, reset]);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => { if (disabled || placing) return; e.preventDefault(); const max = maxTravel(); dragRef.current = { pointerId: e.pointerId, startX: e.clientX, max }; setDragging(true); setOffset(0); setRatio(0); e.currentTarget.setPointerCapture?.(e.pointerId); vibrate(10); };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => { const drag = dragRef.current; if (!drag || drag.pointerId !== e.pointerId) return; e.preventDefault(); const next = Math.max(0, Math.min(e.clientX - drag.startX, drag.max)); setOffset(next); const r = drag.max > 0 ? next / drag.max : 0; setRatio(r); if (r >= COMMIT_RATIO && r < COMMIT_RATIO + 0.06) vibrate(8); };
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => { const drag = dragRef.current; if (!drag || drag.pointerId !== e.pointerId) return; e.currentTarget.releasePointerCapture?.(e.pointerId); const r = drag.max > 0 ? offset / drag.max : 0; if (r >= COMMIT_RATIO) commit(); else reset(); };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || placing) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.key === 'ArrowRight' || e.key === 'End') { e.preventDefault(); commit(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'Home') { e.preventDefault(); reset(); }
  };

  if (!swipe) {
    return <button type="button" disabled={disabled || placing} onClick={onConfirm} className={cn('flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[13px] font-extrabold uppercase tracking-wide shadow-md transition-all active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45 sm:h-14 sm:text-sm', isBuy ? 'bg-success text-success-foreground ring-1 ring-success/40 hover:bg-success/90' : 'bg-destructive text-destructive-foreground ring-1 ring-destructive/40 hover:bg-destructive/90', className)}>{placing ? <Loader2 className="h-5 w-5 animate-spin" /> : <SideIcon className="h-5 w-5" />}<span className="truncate">{placing ? 'Sending…' : label}</span></button>;
  }

  const progress = Math.round(ratio * 100);
  const knobSize = 44;

  return (
    <div ref={trackRef} className={cn('relative h-14 w-full select-none overflow-hidden rounded-xl border touch-none', isBuy ? 'border-success/40 bg-success/[0.08]' : 'border-destructive/40 bg-destructive/[0.08]', disabled || placing ? 'opacity-45' : '', className)} style={{ transition: dragging ? 'none' : undefined }}>
      <div aria-hidden className={cn('absolute inset-y-0 left-0 rounded-xl transition-[width] duration-200 ease-out', isBuy ? 'bg-success/25' : 'bg-destructive/25')} style={{ width: dragging ? offset + knobSize + 4 : ratio === 1 ? '100%' : 0, transitionDuration: dragging ? '0ms' : '160ms' }} />
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5" style={{ opacity: dragging ? Math.max(0.25, 1 - ratio * 1.6) : 1 }}>
        <span className={cn('flex items-center gap-1.5 text-[12px] font-extrabold uppercase tracking-[0.18em]', isBuy ? 'text-success' : 'text-destructive')}>{placing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SideIcon className="h-3.5 w-3.5" />}{placing ? 'Sending…' : `Slide to ${side}`}</span>
        <span className="truncate px-20 text-center font-mono text-[10px] font-semibold tabular-nums text-muted-foreground">{label}</span>
      </div>
      {!dragging && !placing && <ChevronRight aria-hidden className={cn('pointer-events-none absolute left-14 top-1/2 h-5 w-5 -translate-y-1/2 animate-pulse', isBuy ? 'text-success/60' : 'text-destructive/60')} />}
      <button ref={knobRef} type="button" role="slider" aria-label={`Slide to ${side} ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={placing ? 'Sending order' : `Slide to ${side}`} aria-disabled={disabled || placing || undefined} disabled={disabled || placing} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={reset} onKeyDown={onKeyDown} className={cn('absolute left-1 top-1 flex h-12 w-12 touch-none items-center justify-center rounded-lg border border-border/70 bg-card shadow-md', 'transition-[left] duration-200 ease-out active:scale-95', isBuy ? 'text-success' : 'text-destructive')} style={{ left: `${4 + offset}px`, transitionDuration: dragging ? '0ms' : '160ms', transform: dragging ? 'scale(1.05)' : undefined }}><SideIcon className="h-5 w-5" /></button>
    </div>
  );
}