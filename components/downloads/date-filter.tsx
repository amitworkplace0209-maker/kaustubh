'use client';

import { toIST } from '@/lib/ist';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

type DateFilterProps = {
  startDate: string;
  endDate: string;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  onClear: () => void;
  preset: string;
  onPresetChange: (p: string) => void;
};

const PRESETS = [
  { id: 'custom', label: 'Custom' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 Days' },
  { id: '30d', label: 'Last 30 Days' },
];

export function applyPreset(preset: string): { start: string; end: string } {
  const now = toIST(new Date());
  const pad = (n: number) => String(n).padStart(2, '0');
  const toLocal = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  if (preset === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { start: toLocal(start), end: toLocal(now) };
  }
  if (preset === 'yesterday') {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 0, 0);
    return { start: toLocal(start), end: toLocal(end) };
  }
  if (preset === '7d') {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    start.setHours(0, 0, 0, 0);
    return { start: toLocal(start), end: toLocal(now) };
  }
  if (preset === '30d') {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    start.setHours(0, 0, 0, 0);
    return { start: toLocal(start), end: toLocal(now) };
  }
  return { start: '', end: '' };
}

function formatRange(start: string, end: string): string {
  if (!start && !end) return 'No range selected';
  const fmt = (d: string) => {
    if (!d) return '—';
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? '—' : dt.toLocaleString('en-US', {
      timeZone: 'Asia/Kolkata',
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };
  return `${fmt(start)} — ${fmt(end)}`;
}

export default function DateFilter({
  startDate,
  endDate,
  onStartChange,
  onEndChange,
  onClear,
  preset,
  onPresetChange,
}: DateFilterProps) {
  const hasFilter = preset !== 'custom' || startDate || endDate;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base font-semibold">Date & Time</CardTitle>
        {hasFilter && (
          <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <ToggleGroup
          type="single"
          value={preset}
          onValueChange={(v) => { if (v) onPresetChange(v); }}
          className="justify-start flex-wrap"
        >
          {PRESETS.map((p) => (
            <ToggleGroupItem key={p.id} value={p.id} className="text-xs">{p.label}</ToggleGroupItem>
          ))}
        </ToggleGroup>

        {preset === 'custom' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Start Date & Time</Label>
              <Input
                type="datetime-local"
                value={startDate}
                onChange={(e) => onStartChange(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">End Date & Time</Label>
              <Input
                type="datetime-local"
                value={endDate}
                onChange={(e) => onEndChange(e.target.value)}
              />
            </div>
          </div>
        )}

        {hasFilter && (
          <p className="text-sm text-muted-foreground font-mono">
            {formatRange(startDate, endDate)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
