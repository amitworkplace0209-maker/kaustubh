'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, CheckCircle2, Trash2, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  PageHeader, SectionCard, StatusBadge, LoadingState, EmptyState,
} from '@/components/design-system';
import { fmtTimestampIST } from '@/lib/formatters';
import { useRealtime } from '@/components/realtime-provider';
import {
  getAlertDetail, acknowledgeAlert, resolveAlert, deleteAlert,
} from '@/lib/api';

interface AlertItem {
  _id: string;
  rule_id?: string;
  category?: string;
  severity?: string;
  title?: string;
  message?: string;
  status?: 'active' | 'acknowledged' | 'resolved';
  acknowledged?: boolean;
  acknowledged_at?: string;
  acknowledged_by?: string;
  symbol?: string;
  reason?: string;
  reason_code?: string;
  component?: string;
  source?: string;
  related_event_id?: string;
  related_notification_id?: string;
  occurrence_count?: number;
  triggered_at?: string;
  created_at?: string;
  updated_at?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  resolved_at?: string;
  resolved_reason?: string;
  metadata?: Record<string, unknown>;
}

const SEVERITY_COLORS: Record<string, string> = {
  info: 'text-info border-info/30 bg-info/10',
  success: 'text-success border-success/30 bg-success/10',
  warning: 'text-warning border-warning/30 bg-warning/10',
  error: 'text-destructive border-destructive/30 bg-destructive/10',
  critical: 'text-destructive border-destructive/30 bg-destructive/10',
};

const ROWS: { key: keyof AlertItem; label: string }[] = [
  { key: 'rule_id', label: 'Rule' },
  { key: 'category', label: 'Category' },
  { key: 'component', label: 'Component' },
  { key: 'source', label: 'Source' },
  { key: 'symbol', label: 'Symbol' },
  { key: 'reason_code', label: 'Reason code' },
  { key: 'occurrence_count', label: 'Occurrences' },
  { key: 'triggered_at', label: 'Triggered at' },
  { key: 'first_seen_at', label: 'First seen at' },
  { key: 'last_seen_at', label: 'Last seen at' },
  { key: 'resolved_at', label: 'Resolved at' },
  { key: 'acknowledged_at', label: 'Acknowledged at' },
  { key: 'related_event_id', label: 'Related ledger event' },
  { key: 'related_notification_id', label: 'Related notification' },
];

export default function AlertDetailPage() {
  const params = useParams<{ alertId: string }>();
  const router = useRouter();
  const { notifEpoch, hydrated } = useRealtime();
  const alertId = params?.alertId ?? '';
  const [loading, setLoading] = useState(true);
  const [alert, setAlert] = useState<AlertItem | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchOne = useCallback(async () => {
    if (!alertId) return;
    try {
      const res = await getAlertDetail(alertId);
      if (!mountedRef.current) return;
      const item = res?.alert ?? res;
      setAlert(item ?? null);
    } catch {
      if (mountedRef.current) setAlert(null);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [alertId]);

  useEffect(() => { fetchOne(); }, [fetchOne]);

  // Live refresh: resolution/acknowledgement frames arrive via the stream.
  const lastEpoch = useRef(0);
  useEffect(() => {
    if (!hydrated) return;
    if (lastEpoch.current !== 0 && notifEpoch !== lastEpoch.current) fetchOne();
    lastEpoch.current = notifEpoch;
  }, [notifEpoch, hydrated, fetchOne]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await fetchOne();
    } catch {
      // keep page as-is
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingState text="Loading alert..." />;

  if (!alert) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Alert not found"
        description="This alert may have been deleted or the id is invalid"
        action={<Button size="sm" variant="outline" onClick={() => router.push('/data-saver/alerts')}>Back to alerts</Button>}
      />
    );
  }

  const status = alert.status ?? 'active';
  const sev = alert.severity ?? 'info';
  const sevCls = SEVERITY_COLORS[sev] ?? SEVERITY_COLORS.info;
  const live = status !== 'resolved';

  return (
    <div className="space-y-4 pb-2">
      <PageHeader
        title={alert.title || 'Alert'}
        subtitle={`${sev} alert · ${status}`}
      >
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-[10px] ${sevCls}`}>{sev}</Badge>
          {alert.category && <Badge variant="outline" className="text-[10px] text-muted-foreground">{alert.category}</Badge>}
          <StatusBadge
            status={status === 'resolved' ? 'success' : status === 'acknowledged' ? 'info' : 'warning'}
            label={status}
          />
          <Button size="sm" variant="ghost" onClick={() => router.push('/data-saver/alerts')}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back
          </Button>
          {live && (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => acknowledgeAlert(alertId))}>
                <CheckCircle2 className="h-4 w-4 mr-1.5" /> Acknowledge
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => resolveAlert(alertId, 'Marked resolved'))}>
                <XCircle className="h-4 w-4 mr-1.5" /> Resolve
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy}
            onClick={() => run(() => deleteAlert(alertId))}>
            <Trash2 className="h-4 w-4 mr-1.5" /> Delete
          </Button>
        </div>
      </PageHeader>

      <SectionCard title="Details">
        {alert.message && <p className="text-sm text-muted-foreground mb-3">{alert.message}</p>}
        {alert.reason && (
          <p className="text-xs mb-2"><span className="font-medium text-foreground">Reason:</span> {alert.reason}</p>
        )}
        {alert.resolved_reason && (
          <p className="text-xs mb-2"><span className="font-medium text-foreground">Resolution:</span> {alert.resolved_reason}</p>
        )}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {ROWS.map(({ key, label }) => {
            const v = alert[key];
            if (v === undefined || v === null || v === '') return null;
            let text: string;
            if (key === 'triggered_at' || key === 'first_seen_at' || key === 'last_seen_at' ||
                key === 'resolved_at' || key === 'acknowledged_at') {
              text = fmtTimestampIST(String(v));
            } else {
              text = String(v);
            }
            return (
              <div key={key} className="flex items-start justify-between gap-3 border-b border-border/20 py-1.5">
                <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
                <dd className="text-right text-xs tabular-nums break-all">{text}</dd>
              </div>
            );
          })}
          {alert.updated_at && (
            <div className="flex items-start justify-between gap-3 border-b border-border/20 py-1.5">
              <dt className="text-[11px] font-medium text-muted-foreground">Updated at</dt>
              <dd className="text-right text-xs tabular-nums">{fmtTimestampIST(alert.updated_at)}</dd>
            </div>
          )}
        </dl>
      </SectionCard>

      {alert.metadata && Object.keys(alert.metadata).length > 0 && (
        <SectionCard title="Event metadata">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {Object.entries(alert.metadata).map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-3 border-b border-border/20 py-1.5">
                <dt className="text-[11px] font-medium text-muted-foreground">{k}</dt>
                <dd className="text-right text-xs break-all">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>
      )}
    </div>
  );
}