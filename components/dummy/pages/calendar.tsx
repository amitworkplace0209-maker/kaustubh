'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, RefreshCw, Coffee, Clock3, Plus, Trash2, Pin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MetricCard, SectionCard, ErrorState } from '@/components/design-system';
import { getDummyCalendar, getDummyMarketSession, sessionLabel, getDummyCalendarEvents, createDummyCalendarEvent, updateDummyCalendarEvent, deleteDummyCalendarEvent, type CalendarEvent, type MarketSnapshot } from '@/lib/dummy';
import { DummyThemedPage, DummyBadge } from '@/components/dummy/ui';
import { useToast } from '@/hooks/use-toast';

type CalendarPayload = {
  snapshot?: MarketSnapshot;
  sessions?: Array<{ id: string; label: string }>;
  holidays?: Array<{ date: string; name?: string }>;
  is_trading_day?: boolean;
  day_class?: string;
  next_trading_day?: string | null;
  closure_reason?: string | null;
  constraints?: Record<string, string>;
};

type Day = {
  date: string;
  day_class: string;
  trading_day: boolean;
  reason?: string;
};

function isoDaysFrom(date: string, n: number): string[] {
  const [y, m, d] = date.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const dt = new Date(base + i * 86400000);
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

function buildHorizon(today: string, holidays?: Array<{ date: string; name?: string }>): Day[] {
  const lookup = new Map((holidays || []).map((h) => [h.date, h.name || 'NSE/BSE holiday']));
  return isoDaysFrom(today, 14).map((date) => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = lookup.has(date);
    if (!isHoliday && !isWeekend) {
      return { date, day_class: 'NORMAL_MARKET_DAY', trading_day: true };
    }
    if (isHoliday) {
      return { date, day_class: 'EXCHANGE_HOLIDAY', trading_day: false, reason: lookup.get(date) };
    }
    return { date, day_class: 'WEEKEND', trading_day: false };
  });
}

function classifyBadge(day: Day, today: string) {
  if (day.date === today) {
    if (day.trading_day) return <Badge variant="default">Today · Open</Badge>;
    return <Badge variant="destructive">Today · Closed</Badge>;
  }
  if (!day.trading_day) return <Badge variant="destructive">Closed</Badge>;
  return <Badge variant="outline">Trading day</Badge>;
}

export default function DummyCalendar() {
  const [calendar, setCalendar] = useState<CalendarPayload | null>(null);
  const [session, setSession] = useState<MarketSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [form, setForm] = useState({ date: '', category: 'PERSONAL', title: '', note: '', pinned: false, reminderMinutes: '' });
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [cal, sess] = await Promise.all([getDummyCalendar(), getDummyMarketSession()]);
      setCalendar(cal || {});
      setSession(sess);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const res = await getDummyCalendarEvents();
      setEvents(Array.isArray(res?.data) ? res.data : []);
    } catch {
      setEvents([]);
    }
  }, []);

  useEffect(() => { void load(); void loadEvents(); }, [load, loadEvents]);

  if (error && !calendar) {
    return <DummyThemedPage><ErrorState message={error} onRetry={() => void load()} /></DummyThemedPage>;
  }

  const createEvent = async () => {
    if (!form.title.trim() || !form.date) {
      toast({ variant: 'destructive', title: 'Missing fields', description: 'Date and title are required.' });
      return;
    }
    setSaving(true);
    try {
      await createDummyCalendarEvent({
        ...form,
        reminderMinutes: form.reminderMinutes ? Number(form.reminderMinutes) : null,
      });
      toast({ title: 'Event added', description: `${form.date} — ${form.title}` });
      setForm((f) => ({ ...f, title: '', note: '', reminderMinutes: '', pinned: false }));
      void loadEvents();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Create failed', description: e?.detail ?? e?.message });
    } finally {
      setSaving(false);
    }
  };

  const togglePin = async (ev: CalendarEvent) => {
    try {
      await updateDummyCalendarEvent(ev.id, { pinned: !ev.pinned });
      void loadEvents();
    } catch {
      /* keep */
    }
  };

  const removeEvent = async (id: string) => {
    if (!window.confirm('Delete this event?')) return;
    try {
      await deleteDummyCalendarEvent(id);
      void loadEvents();
    } catch {
      /* keep */
    }
  };

  const today = session?.tradingDate || session?.market_date || (calendar?.snapshot?.tradingDate ?? '');
  const holidays = calendar?.holidays || [];
  const horizon = today ? buildHorizon(today, holidays) : [];
  const snap = calendar?.snapshot;

  return (
    <DummyThemedPage>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Market Calendar</h1>
          <DummyBadge />
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard icon={CalendarDays} title="Today (IST)" value={today || '—'} tone="neutral" />
        <MetricCard icon={Clock3} title="Session" value={snap ? sessionLabel(snap.market_session) : '—'} tone={snap?.market_status === 'OPEN' ? 'success' : 'neutral'} />
        <MetricCard icon={Coffee} title="Holidays (4 quarters)" value={String(holidays.length)} tone="warning" />
        <MetricCard icon={CalendarDays} title="Day class" value={(snap?.day_class || calendar?.day_class || '').replace(/_/g, ' ')} tone="teal" />
      </div>

      {snap && (
        <SectionCard title="Next market events (broker-free clock)" icon={Clock3}>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">Next open</div>
              <div className="font-mono">{snap.next_market_open ? new Date(snap.next_market_open).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">Next close</div>
              <div className="font-mono">{snap.next_market_close ? new Date(snap.next_market_close).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">Next trading day</div>
              <div className="font-mono">{calendar?.next_trading_day || '—'}</div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">Now</div>
              <div className="font-mono">{snap.now_ist || '—'}</div>
            </div>
          </div>
          {(snap.closure_reason || calendar?.closure_reason) && (
            <p className="mt-2 text-xs text-amber-500">Closure: {snap.closure_reason || calendar?.closure_reason}</p>
          )}
        </SectionCard>
      )}

      <SectionCard title="Sessions" icon={Clock3}>
        <div className="grid max-w-2xl grid-cols-1 gap-2 sm:grid-cols-3">
          {(calendar?.sessions || []).map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="font-medium">{s.label}</span>
              {calendar?.constraints?.[s.id] && <span className="font-mono text-xs text-muted-foreground">{calendar.constraints[s.id]}</span>}
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Next 14 days" icon={CalendarDays}>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reason / note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {horizon.map((day) => (
                <TableRow key={day.date}>
                  <TableCell className="font-medium tabular-nums">{day.date}</TableCell>
                  <TableCell className="text-sm">{day.day_class.replace(/_/g, ' ')}</TableCell>
                  <TableCell>{classifyBadge(day, today)}</TableCell>
                  <TableCell className="text-muted-foreground">{day.reason || '—'}</TableCell>
                </TableRow>
              ))}
              {horizon.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground">No calendar data yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard title="My Events" icon={Pin}>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <Label className="text-xs">Date</Label>
            <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            <Label className="text-xs">Title</Label>
            <Input placeholder="e.g. Q2 results, record date" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
            <Label className="text-xs">Category</Label>
            <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="TRADING">Trading</SelectItem>
                <SelectItem value="MARKET">Market</SelectItem>
                <SelectItem value="PERSONAL">Personal</SelectItem>
              </SelectContent>
            </Select>
            <div className="space-y-2">
              <Label className="text-xs">Note</Label>
              <Input placeholder="Optional note" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Reminder (minutes before)</Label>
              <Input type="number" min={0} step={5} placeholder="e.g. 15" value={form.reminderMinutes} onChange={(e) => setForm((f) => ({ ...f, reminderMinutes: e.target.value }))} />
            </div>
            <label className="flex items-center gap-2 pt-1 text-xs">
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={form.pinned}
                onChange={(e) => setForm((f) => ({ ...f, pinned: e.target.checked }))}
              />
              Pinned
            </label>
            <Button size="sm" className="w-full" disabled={saving} onClick={() => void createEvent()}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> {saving ? 'Saving…' : 'Add event'}
            </Button>
          </div>

          <div className="lg:col-span-2">
            {events.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No personal events yet — add corporate-action or reminder notes above.</p>
            ) : (
              <div className="max-h-96 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Reminder</TableHead>
                      <TableHead className="w-20" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((ev) => (
                      <TableRow key={ev.id}>
                        <TableCell className="whitespace-nowrap font-medium tabular-nums">{ev.date}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] uppercase">{ev.category}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{ev.title}</div>
                          {ev.note && <div className="text-xs text-muted-foreground">{ev.note}</div>}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{ev.reminderMinutes ? `${ev.reminderMinutes} min` : '—'}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" onClick={() => void togglePin(ev)}>
                            <Pin className={ev.pinned ? 'h-4 w-4 fill-amber-400 text-amber-400' : 'h-4 w-4 text-muted-foreground'} />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => void removeEvent(ev.id)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>
      </SectionCard>
    </DummyThemedPage>
  );
}