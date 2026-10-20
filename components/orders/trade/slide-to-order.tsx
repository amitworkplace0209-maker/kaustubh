'use client';

// ─────────────────────────────────────────────────────────────────────────────
// SLIDE TO ORDER — the PWA confirmation gesture.
//
// WHY THIS EXISTS
// On a phone the order flow used to need FOUR stacked surfaces: the ticket, the
// "Insights" toggle, a sticky action bar, and then a full-screen review modal on
// top of all three. The modal and the sticky bar fight for the same ~120 px of
// viewport, and the single most important control (BUY / SELL) was the one that
// moved the furthest away from the thumb doing the swiping.
//
// This control replaces the MODAL ONLY — it never replaces the risk gate, the
// validation, or `handlePlaceOrder()`. The slide is the confirmation gesture:
// drag the knob to the far edge and the order is submitted through exactly the
// same code path the "Confirm BUY" button used.
//
// PARITY CONTRACT (why this is not a bypass)
//   confirmBuy / confirmSell (per-mode settings) already decide whether a
//   confirmation step exists. The parent passes `swipe` accordingly:
//     · confirm ON  + touch  → slide to confirm   (modal replaced, 1:1)
//     · confirm ON  + mouse → review modal        (unchanged desktop flow)
//     · confirm OFF + any   → direct place        (user opted out, honoured)
//   A user who turned confirmation OFF is never forced to swipe, and a user who
//   left it ON always gets exactly one deliberate gesture.
//
// ACCESSIBILITY
// The knob is a real focusable `role="slider"`: Enter / Space / ArrowRight /
// End complete the action, so the order is never locked behind a drag. Pointer
// events are used (not touch events) so a stylus, a mouse drag and a finger all
// take the identical path.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OrderSide } from '@/components/orders/trade/types';

/** Fraction of the track the knob must cross for the order to fire. */
const COMMIT_RATIO = 0.82;

function vibrate(pattern: number | number[]) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    /* haptics are a nicety — never let them break an order */
  }
}

export function SlideToOrder({
  side,
  label,
  disabled,
  placing,
  swipe,
  onConfirm,
  className,
}: {
  side: OrderSide;
  /** Text shown inside the track, e.g. "BUY RELIANCE × 5". */
  label: string;
  disabled?: boolean;
  placing?: boolean;
  /** Render the drag gesture (true) or the plain tap button (false). */
  swipe?: boolean;
  onConfirm: () => void;
  className?: string;
}) {
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
    // 4px inset on each side of the track + the knob itself.
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
    // Let the knob visibly reach the end BEFORE the request starts, so the
    // gesture never looks like it was swallowed by the network.
    window.setTimeout(() => {
      setDragging(false);
      onConfirm();
    }, 130);
    // Snap back after the parent has flipped to `placing`.
    window.setTimeout(reset, 420);
  }, [disabled, placing, onConfirm, reset]);

  // A layout change (rotation, sheet open, keyboard) invalidates the cached
  // travel distance — re-clamp so the knob can never end up off-track.
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

  // Escape aborts a half-finished drag.
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
    // One tick the moment the knob passes the commit line.
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
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.key === 'ArrowRight' || e.key === 'End') {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'Home') {
      e.preventDefault();
      reset();
    }
  };

  // ── Tap button: desktop, and every touch build with confirmation turned off ──
  if (!swipe) {
    return (
      <button
        type="button"
        disabled={disabled || placing}
        onClick={onConfirm}
        className={cn(
          'flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[13px] font-extrabold uppercase tracking-wide shadow-md transition-all active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45 sm:h-14 sm:text-sm',
          isBuy
            ? 'bg-success text-success-foreground ring-1 ring-success/40 hover:bg-success/90'
            : 'bg-destructive text-destructive-foreground ring-1 ring-destructive/40 hover:bg-destructive/90',
          className,
        )}
      >
        {placing ? <Loader2 className="h-5 w-5 animate-spin" /> : <SideIcon className="h-5 w-5" />}
        <span className="truncate">{placing ? 'Sending…' : label}</span>
      </button>
    );
  }

  // ── Slide track ──
  const progress = Math.round(ratio * 100);
  const knobSize = 44; // h-11 knob, minus the 4px inset on each side

  return (
    <div
      ref={trackRef}
      className={cn(
        'relative h-14 w-full select-none overflow-hidden rounded-xl border touch-none',
        isBuy ? 'border-success/40 bg-success/[0.08]' : 'border-destructive/40 bg-destructive/[0.08]',
        disabled || placing ? 'opacity-45' : '',
        className,
      )}
      style={{ transition: dragging ? 'none' : undefined }}
    >
      {/* Filled portion behind the knob */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 rounded-xl transition-[width] duration-200 ease-out',
          isBuy ? 'bg-success/25' : 'bg-destructive/25',
        )}
        style={{
          width: dragging ? offset + knobSize + 4 : ratio === 1 ? '100%' : 0,
          transitionDuration: dragging ? '0ms' : '160ms',
        }}
      />

      {/* Centre label — fades out as the knob approaches so the two never collide */}
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
          {placing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SideIcon className="h-3.5 w-3.5" />}
          {placing ? 'Sending…' : `Slide to ${side}`}
        </span>
        <span className="truncate px-20 text-center font-mono text-[10px] font-semibold tabular-nums text-muted-foreground">
          {label}
        </span>
      </div>

      {/* Hint chevrons — sit just ahead of the knob (not behind the label) so the
          two never collide, and only while idle so a resting track still reads
          as draggable. */}
      {!dragging && !placing && (
        <ChevronRight
          aria-hidden
          className={cn(
            'pointer-events-none absolute left-14 top-1/2 h-5 w-5 -translate-y-1/2 animate-pulse',
            isBuy ? 'text-success/60' : 'text-destructive/60',
          )}
        />
      )}

      {/* Knob */}
      <button
        ref={knobRef}
        type="button"
        role="slider"
        aria-label={`Slide to ${side} ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
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
        {placing ? <Loader2 className="h-5 w-5 animate-spin" /> : <SideIcon className="h-5 w-5" />}
      </button>
    </div>
  );
}