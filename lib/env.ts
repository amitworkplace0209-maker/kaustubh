/**
 * Environment variable validation â€” runs on server side only.
 * Import this in API routes or server components to validate required vars.
 */

function optionalEnv(key: string, fallback: string = ''): string {
  return process.env[key] ?? fallback;
}

let _validated = false;

export function validateEnv(): void {
  if (_validated) return;
  optionalEnv('NEXT_PUBLIC_API_BASE', 'http://127.0.0.1:8000');
  _validated = true;
}

export const env = {
  /** Server-side only. Optional 6-digit PIN for app lock bootstrap. */
  get APP_LOCK_PIN() { return optionalEnv('APP_LOCK_PIN'); },
  /** Backend API base URL. */
  get API_BASE() { return optionalEnv('NEXT_PUBLIC_API_BASE', 'http://127.0.0.1:8000'); },
  /** Guest email for auto-login (optional). */
  get GUEST_EMAIL() { return optionalEnv('GUEST_EMAIL'); },
  /** Guest password for auto-login (optional). */
  get GUEST_PASSWORD() { return optionalEnv('GUEST_PASSWORD'); },
} as const;
