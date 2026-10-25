'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronRight, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OrderSide } from '@/components/orders/trade/types';

const COMMIT_RATIO = 0.82;

export interface OrderActionsSummary {
  orderType: string;
  product: string;
  validity: string;
  quantity: number | null;
  limit: number | null;
  margin: number | null;
  ltp: number | null;
  currency: string;
}

export interface OrderActionsProps {
  side: OrderSide;
  symbol: string;
  disabled?: boolean;
  placing?: boolean;
  /** True on a touch build: the commit gesture is a slide, not a tap. */
  swipe?: boolean;
  onConfirm: () => void;
  summary: OrderActionsSummary;
  onFlip: () => void;
}

function vibrate(pattern: number | number[]) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    /* haptics are optional */
  }
}

/**
 * The action bar — the last thing between the operator and the exchange.
 *
 * It is viewport-fixed on mobile (above the app's bottom navigation) and
 * sticky on desktop. On a touch build the commit gesture is a SLIDE (a
 * deliberate, one-gesture confirmation); on a mouse it is a tap that opens
 * the review dialog. The confirm SETTINGS decide whether a confirmation step
 * exists at all — the gesture is its implementation, never a bypass.
 */
export const OrderActions = memo(function OrderActions({
  side,
  symbol,
  disabled,
  placing,
  swipe,
  onConfirm,
  summary,
  onFlip,
}: OrderActionsProps) {
  const isBuy = side === 'BUY';
  const SideIcon = isBuy ? TrendingUp : TrendingDown;
  const money = (v: number | null | undefined, digits = 2) =>
    v == null || !Number.isFinite(v)
      ? '—'
      : `${summary.currency}${v.toLocaleString('en-IN', {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })}`;

  const trackRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; max: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [ratio, setRatio] = useState(0);

  const maxTravel = useCallback(() => {
    const track = trackRef.current;
    const knob = knobRef.current;
    if (!track || !knob) return 0;
    return Math.max(0, track.clientWidth - knob.offsetWidth - 8);
  }, []);

  const reset = useCallback(() => {
    dragRef.current = null;
    setOffset(0);
    setRatio(0);
    setDragging(false);
  }, []);

  const commit = useCallback(() => {
    if (disabled || placing) return;
    dragRef.current = null;
    setRatio(1);
    vibrate([12, 40, 18]);
    setTimeout(() => {
      setDragging(false);
      onConfirm();
    }, 130);
    setTimeout(reset, 420);
  }, [disabled, placing, onConfirm, reset]);

  useEffect(() => {
    const onResize = () => {
      if (!dragging) return;
      setOffset((o) => Math.min(o, maxTravel()));
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [dragging, maxTravel]);

  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') reset();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging, reset]);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || placing) return;
    e.preventDefault();
    const max = maxTravel();
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, max };
    setDragging(true);
    setOffset(0);
    setRatio(0);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    vibrate(10);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(e.clientX - drag.startX, drag.max));
    setOffset(next);
    const r = drag.max > 0 ? next / drag.max : 0;
    setRatio(r);
    if (r >= COMMIT_RATIO && r < COMMIT_RATIO + 0.06) vibrate(8);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const r = drag.max > 0 ? offset / drag.max : 0;
    if (r >= COMMIT_RATIO) commit();
    else reset();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || placing) return;
    if (
      e.key === 'Enter' ||
      e.key === ' ' ||
      e.key === 'Spacebar' ||
      e.key === 'ArrowRight' ||
      e.key === 'End'
    ) {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'Home') {
      e.preventDefault();
      reset();
    }
  };

  const label = `${side} ${symbol}`.trim();

  return (
    <div
      data-verify="trade-order-bar"
      className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-border/60 bg-background/95 px-3 py-2 backdrop-blur-md md:sticky md:bottom-0 md:z-20 md:-mx-6 md:px-6 md:py-3"
    >
      <div className="mx-auto w-full max-w-[1400px]">
        {!swipe ? (
          <button
            type="button"
            disabled={disabled || placing}
            onClick={onConfirm}
            className={cn(
              'flex h-13 w-full items-center justify-center gap-2 rounded-xl text-[14px] font-extrabold uppercase tracking-wide shadow-md transition-all active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45',
              isBuy
                ? 'bg-success text-success-foreground ring-1 ring-success/40 hover:bg-success/90'
                : 'bg-destructive text-destructive-foreground ring-1 ring-destructive/40 hover:bg-destructive/90',
            )}
            style={{ height: 52 }}
          >
            {placing ? <Loader2 className="h-5 w-5 animate-spin" /> : <SideIcon className="h-5 w-5" />}
            <span className="truncate">{placing ? 'Sending…' : label}</span>
          </button>
        ) : (
          <div
            ref={trackRef}
            className={cn(
              'relative h-14 w-full select-none overflow-hidden rounded-xl border touch-none',
              isBuy ? 'border-success/40 bg-success/[0.08]' : 'border-destructive/40 bg-destructive/[0.08]',
              disabled || placing ? 'opacity-45' : '',
            )}
            style={{ transition: dragging ? 'none' : undefined }}
          >
            <div
              aria-hidden
              className={cn(
                'absolute inset-y-0 left-0 rounded-xl transition-[width] duration-200 ease-out',
                isBuy ? 'bg-success/25' : 'bg-destructive/25',
              )}
              style={{
                width: dragging ? offset + 48 : ratio === 1 ? '100%' : 0,
                transitionDuration: dragging ? '0ms' : '160ms',
              }}
            />
            <div
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5"
              style={{ opacity: dragging ? Math.max(0.25, 1 - ratio * 1.6) : 1 }}
            >
              <span
                className={cn(
                  'flex items-center gap-1.5 text-[12px] font-extrabold uppercase tracking-[0.18em]',
                  isBuy ? 'text-success' : 'text-destructive',
                )}
              >
                {placing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <SideIcon className="h-3.5 w-3.5" />
                )}
                {placing ? 'Sending…' : `Slide to ${side}`}
              </span>
              <span className="truncate px-20 text-center font-mono text-[11px] font-semibold tabular-nums text-muted-foreground">
                {label}
              </span>
            </div>
            {!dragging && !placing && (
              <ChevronRight
                aria-hidden
                className={cn(
                  'pointer-events-none absolute left-14 top-1/2 h-5 w-5 -translate-y-1/2 animate-pulse',
                  isBuy ? 'text-success/60' : 'text-destructive/60',
                )}
              />
            )}
            <button
              ref={knobRef}
              type="button"
              role="slider"
              aria-label={`Slide to ${side} ${label}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(ratio * 100)}
              aria-valuetext={placing ? 'Sending order' : `Slide to ${side}`}
              aria-disabled={disabled || placing || undefined}
              disabled={disabled || placing}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={reset}
              onKeyDown={onKeyDown}
              className={cn(
                'absolute left-1 top-1 flex h-12 w-12 touch-none items-center justify-center rounded-lg border border-border/70 bg-card shadow-md',
                'transition-[left] duration-200 ease-out active:scale-95',
                isBuy ? 'text-success' : 'text-destructive',
              )}
              style={{
                left: `${4 + offset}px`,
                transitionDuration: dragging ? '0ms' : '160ms',
                transform: dragging ? 'scale(1.05)' : undefined,
              }}
            >
              <SideIcon className="h-5 w-5" />
            </button>
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
          <span className="flex min-w-0 items-center gap-1.5 font-mono tabular-nums text-muted-foreground">
            <span className="truncate">
              {summary.orderType === 'MKT' ? 'MKT' : `@ ${money(summary.limit)}`} · {summary.product} ·{' '}
              {summary.validity}
            </span>
            <span className="hidden sm:inline">· ×{summary.quantity ?? '—'}</span>
            <span className="hidden md:inline">· Mgn {money(summary.margin, 0)}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="font-mono tabular-nums text-muted-foreground">
              LTP {summary.ltp != null ? money(summary.ltp) : '—'}
            </span>
            <button
              type="button"
              onClick={onFlip}
              aria-label={`Switch the order side to ${isBuy ? 'SELL' : 'BUY'}`}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95"
            >
              <ArrowLeftRight className="h-3 w-3" />
              {isBuy ? 'SELL' : 'BUY'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
});
