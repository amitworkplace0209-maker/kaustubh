'use client';

// Safe numeric/date formatting helpers (requirement §35).
// NEVER call .toFixed() / .toLocaleString() directly on unknown API values.
// Every helper guards against null / undefined / non-finite input.

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNullableNumber(v: unknown): number | null {
  return toNumber(v);
}

function formatPrice(v: unknown): string {
  const n = toNumber(v);
  return n == null ? 'Not provided' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(v: unknown): string {
  const n = toNumber(v);
  return n == null ? '—' : `${n.toFixed(2)}%`;
}

function formatVolume(v: unknown): string {
  const n = toNumber(v);
  if (n == null) return 'Not provided';
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return String(n);
}

function formatTimestamp(v: unknown): string {
  if (v == null || v === '') return 'Not provided';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return 'Not provided';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatBytes(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'Unavailable';
  const a = Math.abs(v);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = a;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 10 ? 1 : 2)} ${units[i]}`;
}

export {
  toNumber,
  toNullableNumber,
  formatPrice,
  formatPercent,
  formatVolume,
  formatTimestamp,
  formatBytes,
};
