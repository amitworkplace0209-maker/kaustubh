'use client';

// ---- Reusable expandable charge breakdown ----
//
// Closed by default. One click opens the FULL statutory breakdown,
// one click closes it. Used by position cards (open/closed), the trading
// calculator and anywhere charges need a consistent disclosure pattern.
//
// Data-quality rule: null = unavailable -> "N/A"; 0 = actual zero -> "₹0.00".

import { useState } from 'react';
import { ChevronDown, ChevronUp, Receipt } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { fmtRs } from '@/lib/formatters';
import { cn } from '@/lib/utils';

export type ChargeDetailsValues = {
  brokerage?: number | null;
  stt?: number | null;
  exchangeTransactionCharges?: number | null;
  sebiCharges?: number | null;
  stampDuty?: number | null;
  gst?: number | null;
  otherCharges?: number | null;
  totalCharges?: number | null;
};

export type ChargeDetailsProps = {
  values: ChargeDetailsValues | null | undefined;
  turnover?: number | null;
  gstTaxableBase?: number | null;
  calculationVersion?: string | null;
  calculatedAt?: string | null;
  /** true = provider-confirmed, false/undefined = configured-rules estimate. */
  confirmed?: boolean;
  className?: string;
  compact?: boolean;
};

function Row({ label, value, strong, accent }: {
  label: string; value: string; strong?: boolean; accent?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3', strong ? 'text-xs' : 'text-[11px]')}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('text-right font-mono tabular-nums', strong ? 'font-semibold text-xs' : '', accent ?? '')}>
        {value}
      </span>
    </div>
  );
}

export function ChargeDetails({
  values, turnover, gstTaxableBase, calculationVersion, calculatedAt,
  confirmed, className, compact,
}: ChargeDetailsProps) {
  const [open, setOpen] = useState(false);
  const v = values ?? {};
  const hasAny = v.totalCharges != null || Object.values(v).some((x) => x != null);

  return (
    <div className={cn('rounded-lg border border-border/50 overflow-hidden', compact ? '' : 'bg-muted/20', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 transition-colors hover:bg-muted/40"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Receipt className="h-3 w-3 shrink-0" />
          Charge Details
        </span>
        <span className="flex items-center gap-1.5">
          {confirmed ? (
            <Badge variant="outline" className="border-success/30 bg-success/10 px-1 py-0 h-4 text-[9px] font-semibold text-success">
              CONFIRMED
            </Badge>
          ) : (
            <Badge variant="outline" className="border-warning/30 bg-warning/10 px-1 py-0 h-4 text-[9px] font-semibold text-warning">
              ESTIMATE
            </Badge>
          )}
          {open ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
        </span>
      </button>

      {open && (
        <div className="animate-fade-in space-y-1 border-t border-border/50 px-2.5 py-2">
          {!hasAny ? (
            <p className="py-1 text-[11px] text-muted-foreground">
              No executed fills yet &mdash; charges appear once orders execute.
            </p>
          ) : (
            <>
              <Row label="Brokerage" value={fmtRs(v.brokerage)} />
              <Row label="STT" value={fmtRs(v.stt)} />
              <Row label="Exchange Charges" value={fmtRs(v.exchangeTransactionCharges)} />
              <Row label="SEBI" value={fmtRs(v.sebiCharges)} />
              <Row label="Stamp Duty" value={fmtRs(v.stampDuty)} />
              <Row label="GST" value={fmtRs(v.gst)} />
              <Row label="Other Charges" value={fmtRs(v.otherCharges)} />
              <div className="my-1 border-t border-border/40" />
              <Row label="Total Charges" value={fmtRs(v.totalCharges)} strong />
              <Row label="Turnover" value={fmtRs(turnover)} />
              <Row label="GST Taxable Base" value={fmtRs(gstTaxableBase)} />
              {calculationVersion && (
                <Row label="Calculation Version" value={calculationVersion} />
              )}
              {calculatedAt && (
                <Row
                  label="Calculated At"
                  value={new Date(calculatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, })}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
