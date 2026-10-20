'use client';

import { Activity, Clock4, ShieldCheck, Zap } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalLink, RefreshCw } from 'lucide-react';
import {
  fmtHHMM, fmtNum, PHASE_ORDER, READY_TONE, useSchedulerData,
} from '@/app/_pages/scheduler/scheduler-data';

/**
 * SERVICES -> Scheduler Engine -> Trading-day Timeline
 *
 * Today's lifecycle instants + the 10-phase schedule + the spec §6 readiness
 * report. All values come from /api/scheduler/status, /api/scheduler/readiness
 * and /api/scheduler/summary (real backend data, backend IST clock only).
 */
export default function SchedulerTimelinePage() {
  const { engine, status, statusError, readiness, readinessError, summary, summaryError, reload } = useSchedulerData();

  const realStatus = engine?.realStatus ?? {};
  const phases = (status?.todayPhases ?? readiness?.phases ?? {}) as Record<string, string>;
  const daySchedule = summary?.day_schedule ?? status?.todaySchedule ?? {};
  const isTradingDay = summary?.is_trading_day ?? status?.isTradingDay ?? null;

  const checks: any[] = Array.isArray(readiness?.readiness?.checks)
    ? (readiness?.readiness?.checks as any[])
    : Array.isArray(status?.readiness?.checks)
      ? (status?.readiness?.checks as any[])
      : [];
  const readinessOverall = readiness?.readiness?.overall ?? status?.readiness?.overall ?? null;
  const readinessApplicable = readiness?.readiness?.applicable ?? status?.readiness?.applicable ?? null;
  const critical = checks.filter((c) => c.critical);
  const readyCount = critical.filter((c) => c.ready).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Clock4 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Scheduler Timeline</h1>
            <p className="text-xs text-muted-foreground">
              Trading-day lifecycle instants · phase schedule · readiness report (IST, +05:30)
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={reload}>
          <RefreshCw className="mr-1 h-3 w-3" /> Refresh
        </Button>
      </div>

      {(statusError || readinessError || summaryError) && (
        <div className="rounded bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {statusError && <div>Lifecycle status: {statusError}</div>}
          {readinessError && <div>Readiness report: {readinessError}</div>}
          {summaryError && <div>Ledger summary: {summaryError}</div>}
        </div>
      )}

      <Card className="shadow-soft">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <div className="flex items-center gap-2"><Clock4 className="h-4 w-4 text-primary" /><CardTitle className="text-sm">Trading-day timeline (IST)</CardTitle></div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{isTradingDay === null ? '\u2014' : isTradingDay ? 'TRADING DAY' : 'NOT A TRADING DAY'}</Badge>
            <Link href="/services/scheduler/history" className="text-[10px] text-primary hover:underline">History <ExternalLink className="inline h-3 w-3" /></Link>
          </div>
        </CardHeader>
        <CardContent>
          {Object.keys(daySchedule).length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">No trading-day schedule available right now.</div>
          ) : (
            <div className="grid gap-1.5 text-xs sm:grid-cols-2 lg:grid-cols-5">
              {[
                ['login', 'Login', summary?.login ?? status?.todaySchedule?.login],
                ['tick_collection', 'Tick collection', summary?.tick_collection ?? status?.todaySchedule?.tickCollection],
                ['ws_connect', 'WebSocket connect', summary?.websocket_connect ?? status?.todaySchedule?.wsConnect],
                ['ws_disconnect', 'WebSocket disconnect', summary?.websocket_disconnect ?? status?.todaySchedule?.wsDisconnect],
                ['logout', 'Logout', summary?.logout ?? status?.todaySchedule?.logout],
              ].map(([key, label]) => (
                <div key={key} className="flex flex-col gap-1 rounded bg-white/5 px-3 py-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
                  <span className="font-mono text-sm">{fmtHHMM(daySchedule[key] ?? null)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-soft">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <div className="flex items-center gap-2"><Zap className="h-4 w-4 text-primary" /><CardTitle className="text-sm">Phase schedule</CardTitle></div>
          <Badge variant="outline">{Object.keys(phases).length ? fmtNum(Object.keys(phases).length) : '\u2014'}</Badge>
        </CardHeader>
        <CardContent>
          {Object.keys(phases).length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">Phase schedule not available (no trading day).</div>
          ) : (
            <div className="grid gap-1.5 text-xs sm:grid-cols-2 lg:grid-cols-5">
              {PHASE_ORDER.map(({ key, label }) => {
                const iso = phases[key];
                return (
                  <div key={key} className="flex items-center justify-between rounded bg-white/5 px-3 py-1.5">
                    <span className="text-muted-foreground">{label}</span>
                    <span className={`font-mono ${key === (realStatus.phase ?? status?.phase) ? 'text-primary' : ''}`}>{iso ? fmtHHMM(iso) : '\u2014'}</span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-soft">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><CardTitle className="text-sm">Readiness report (spec §6)</CardTitle></div>
          {readinessOverall ? (
            <Badge className={READY_TONE[readinessOverall] ?? ''}>{readinessOverall}</Badge>
          ) : (
            <Badge variant="outline">{readinessApplicable === false ? 'NOT APPLICABLE' : '\u2014'}</Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <span><span className="text-muted-foreground">Critical ready</span> <span className="font-mono">{critical.length ? `${readyCount}/${critical.length}` : '\u2014'}</span></span>
            <span><span className="text-muted-foreground">Total checks</span> <span className="font-mono">{checks.length ? fmtNum(checks.length) : '\u2014'}</span></span>
            <span><span className="text-muted-foreground">As of</span> <span className="font-mono">{fmtHHMM(readiness?.readiness?.as_of ?? status?.readiness?.as_of)}</span></span>
            <span><span className="text-muted-foreground">Current phase</span> <span className="font-mono">{realStatus.phase ?? status?.phase ?? '\u2014'}</span></span>
            <span><span className="text-muted-foreground">Next phase</span> <span className="font-mono">{status?.nextPhase ?? '\u2014'}</span></span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            <span>A critical failure surfaces overall = NOT_READY (critical components probed live).</span>
          </div>
          {checks.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              {readinessApplicable === false
                ? 'Readiness not applicable — not a trading day.'
                : 'Readiness checks unavailable right now.'}
            </div>
          ) : (
            <div className="overflow-auto rounded-lg border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1">Component</th>
                    <th className="px-2 py-1">Critical</th>
                    <th className="px-2 py-1">Ready</th>
                    <th className="px-2 py-1">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {checks.map((c: any, i: number) => (
                    <tr key={c.component ?? i} className="border-t">
                      <td className="px-2 py-1 font-medium">{c.component ?? '\u2014'}</td>
                      <td className="px-2 py-1 font-mono">{c.critical ? 'YES' : 'no'}</td>
                      <td className="px-2 py-1">
                        {c.ready == null
                          ? <Badge variant="outline">UNKNOWN</Badge>
                          : (c.ready
                              ? <Badge variant="outline" className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">READY</Badge>
                              : <Badge variant="outline" className="bg-rose-500/15 text-rose-300 border-rose-500/30">NOT READY</Badge>
                          )}
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">{c.detail ?? '\u2014'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}