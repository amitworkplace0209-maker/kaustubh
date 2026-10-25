// Shared financial/system formatting utilities.
// Single source of truth so every page renders values identically.

export function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** ₹1,234.56 — neutral INR amount. */
export function fmtRs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  return `\u20B9${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** +₹1,250.00 / -₹785.50 / ₹0.00 — signed P&L with exactly 2 decimals. */
export function fmtPnl(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  if (n === 0) return '\u20B90.00';
  const abs = `\u20B9${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return n > 0 ? `+${abs}` : `-${abs}`;
}

/** +2.45% / -1.72% / 0.00% */
export function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  if (n === 0) return '0.00%';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** Signed plain percent with one decimal, for utilizations etc. */
export function fmtPct1(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '\u2014';
  return `${n.toFixed(1)}%`;
}

export function fmtQty(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-IN') : '0';
}

/** Response time in ms, e.g. "32ms". */
export function fmtMs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  return `${Math.round(n)}ms`;
}

/** Bytes → human readable (B/KB/MB/GB/TB/PB). */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** Seconds → "3d 4h 12m" style uptime. */
export function fmtUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'N/A';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** ISO timestamp → locale date-time, or fallback label when missing. */
export function fmtDateTime(iso: string | null | undefined, fallback = 'N/A'): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return fallback;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/** ISO timestamp → "DD/MM/YYYY HH:MM:SS IST" (Asia/Kolkata explicit). */
export function fmtTimestampIST(iso: string | null | undefined, fallback = '\u2014'): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return fallback;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  return `${fmt.format(d)} IST`;
}

export type Tone = 'ok' | 'bad' | 'warn' | 'unknown';

/** Text color class for a signed value (green/red/neutral). */
export function pnlClr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'text-muted-foreground';
  if (n > 0) return 'text-success';
  if (n < 0) return 'text-destructive';
  return 'text-muted-foreground';
}

/** Left border accent for a signed value. */
export function pnlAccent(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'border-l-2 border-l-border';
  if (n > 0) return 'border-l-2 border-l-success';
  if (n < 0) return 'border-l-2 border-l-destructive';
  return 'border-l-2 border-l-border';
}
