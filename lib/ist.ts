export const IST_TIMEZONE = 'Asia/Kolkata';

function toDate(input: Date | string | number): Date {
  return input instanceof Date ? new Date(input.getTime()) : new Date(input);
}

export function toIST(date: Date | string | number): Date {
  const d = toDate(date);
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  return new Date(
    Date.UTC(
      parseInt(parts.year),
      parseInt(parts.month) - 1,
      parseInt(parts.day),
      parseInt(parts.hour),
      parseInt(parts.minute),
      parseInt(parts.second),
    ),
  );
}

export function formatIST(
  date: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = toDate(date);
  return d.toLocaleString('en-IN', {
    timeZone: IST_TIMEZONE,
    ...options,
  });
}

export function formatISTTime(date: Date | string): string {
  return formatIST(date, { hour: 'numeric', minute: '2-digit', hour12: true });
}

export function formatISTDate(date: Date | string): string {
  return formatIST(date, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatISTDateTime(date: Date | string): string {
  return formatIST(date, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });
}

export function getISTNow(): Date {
  return toIST(new Date());
}

export function getISTTimestamp(): string {
  return getISTNow().toISOString();
}

/**
 * Business date in IST as 'YYYY-MM-DD'.
 * `toISOString().slice(0, 10)` is the UTC date and is wrong for every
 * IST instant between 00:00 and 05:30, so it must not be used for business dates.
 */
export function istDateKey(date: Date | string | number = new Date()): string {
  return toIST(date).toISOString().slice(0, 10);
}

/** Wall-clock 'HH:MM:SS' in IST, independent of the host timezone. */
export function istTimeKey(date: Date | string | number = new Date()): string {
  return toIST(date).toISOString().slice(11, 19);
}

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60000);
  const hours = Math.floor(minutes / 60);
  const secs = Math.floor((abs % 60000) / 1000);

  if (hours > 0) {
    const m = minutes % 60;
    return `${hours}h${m > 0 ? ` ${m}m` : ''} ago`;
  }
  if (minutes > 0) {
    return `${minutes} min ago`;
  }
  return `${secs} sec ago`;
}
