'use client';

// ---- Shared live-schedule consumer for the Schedules page ----
//
// Subscribes to the server-side scheduler lifecycle event stream
// (/api/schedule-events/stream) which is broadcast by the backend's
// event_bus whenever a schedule transitions state (DUE, RUNNING,
// COMPLETED, FAILED, PACKAGE_READY, etc.).
//
// A freshly-reconnected tab receives the latest state from the
// backend's 15s heartbeat snapshot frames, so it converges instantly
// without a full page refresh.

import { useEffect, useState, useRef } from 'react';
import {
  subscribeScheduleEvents, subscribeScheduleState,
} from '@/lib/schedule-sse';

/** Every SSE payload from the scheduler carries these fields. */
export interface ScheduleEvent {
  event: string;
  scheduleId: string | null;
  scheduleName: string | null;
  ts: string;
  eventId: string;
  /** Additional event-specific fields (error, packageId, trigger, etc.). */
  [key: string]: unknown;
}

/** Per-schedule latest state, used for live card transitions. */
export interface ScheduleState {
  scheduleId: string;
  scheduleName: string | null;
  status: 'idle' | 'due' | 'running' | 'success' | 'failed' | 'waiting' | 'retrying' | 'skipped' | 'missed';
  lastEvent: ScheduleEvent;
  lastEventTs: number;
  /** PACKAGE_READY payload, kept until consumed by auto-download. */
  packageReady?: ScheduleEvent;
}

export interface UseScheduleEventsResult {
  connected: boolean;
  lastEventAt: number | null;
  /** Most recent events (newest first), capped at 50. */
  recentEvents: ScheduleEvent[];
  /** Per-schedule state map keyed by scheduleId. */
  scheduleStates: Map<string, ScheduleState>;
}

const MAX_EVENTS = 50;
const MAX_STATES = 200;

export function useScheduleEvents(enabled = true): UseScheduleEventsResult {
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [recentEvents, setRecentEvents] = useState<ScheduleEvent[]>([]);
  const [scheduleStates, setScheduleStates] = useState<Map<string, ScheduleState>>(new Map());

  /** Read inside the frame listener without resubscribing on toggle. */
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) return;
    // ONE schedule-events stream for the whole browser session — the shared
    // module owns the EventSource + reconnect; this hook only consumes frames.
    const offState = subscribeScheduleState((s) => setConnected(Boolean(s.connected)));
    const offEvents = subscribeScheduleEvents((frame) => {
      if (!enabledRef.current) return;
      const ev = frame as ScheduleEvent;
      if (!ev?.event) return;

      const now = Date.now();
      setLastEventAt(now);

      // Push to recent events ring buffer.
      setRecentEvents((prev) => {
        const next = [ev, ...prev].slice(0, MAX_EVENTS);
        return next;
      });

      // Update per-schedule state machine.
      if (ev.scheduleId) {
        setScheduleStates((prev) => {
          const next = new Map(prev);
          const sid = ev.scheduleId!;
          const existing = next.get(sid);
          const status = eventToStatus(ev.event);

          // Only overwrite if the event is "newer" or same direction.
          if (!existing || now >= existing.lastEventTs) {
            const state: ScheduleState = {
              scheduleId: sid,
              scheduleName: ev.scheduleName ?? existing?.scheduleName ?? null,
              status,
              lastEvent: ev,
              lastEventTs: now,
              packageReady: ev.event === 'PACKAGE_READY' ? ev : existing?.packageReady,
            };
            next.set(sid, state);
          }
          // Cap map size.
          while (next.size > MAX_STATES) {
            const oldest = next.keys().next().value;
            if (oldest == null) break;
            next.delete(oldest);
          }
          return next;
        });
      }
    });

    return () => {
      offState();
      offEvents();
      setConnected(false);
    };
  }, [enabled]);

  return { connected, lastEventAt, recentEvents, scheduleStates };
}

/** Map a backend event name to a UI status string. */
function eventToStatus(event: string): ScheduleState['status'] {
  switch (event) {
    case 'SCHEDULE_DUE': return 'due';
    case 'SCHEDULE_RUNNING': return 'running';
    case 'SCHEDULE_EXPORT_STARTED': return 'running';
    case 'SCHEDULE_COMPLETED': return 'success';
    case 'SCHEDULE_FAILED': return 'failed';
    case 'SCHEDULE_WAITING': return 'waiting';
    case 'SCHEDULE_RETRYING': return 'retrying';
    case 'SCHEDULE_SKIPPED': return 'skipped';
    case 'SCHEDULE_MISSED': return 'missed';
    case 'SCHEDULE_CREATED': return 'idle';
    case 'SCHEDULE_UPDATED': return 'idle';
    case 'SCHEDULE_DELETED': return 'idle';
    case 'PACKAGE_READY': return 'success';
    default: return 'idle';
  }
}
