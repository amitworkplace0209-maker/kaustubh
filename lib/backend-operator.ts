import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { backendFetch } from '@/lib/backend';

/**
 * Backend OPERATOR JWT acquisition (server-side only).
 *
 * Backend mutations (terminal connect / order placement / JWT-gated receive)
 * require an operator JWT issued by the Python service from `APP_USERNAME` /
 * `APP_PASSWORD`. Those secrets live in the backend env file on this machine;
 * the Next layer reads them server-side and trades them for a JWT, so the
 * secret itself is never handed to a browser.
 *
 * Two server-side consumers share this module (and its JWT cache):
 *   * `app/api/realtime/token` — mounts the JWT while requesting a realtime
 *     gateway token (the browser only ever sees the short-live WS token);
 *   * `app/api/auth/trading-token` — hands the JWT to an ALREADY cookie-signed-in
 *     browser session so the trade page can call the broker surface with an
 *     in-memory (never persisted) token, exactly as if the operator had typed
 *     the password into the trade page's sign-in form.
 *
 * The env file is read in ascending priority order because the backend keeps a
 * single source of truth for its password instead of duplicating the secret
 * into a second file.
 */

const OPERATOR_JWT_TTL_MS = 28_800_000; // backend issue_token TTL
// The operator login is cheap (~2-50ms) but the FIRST call after a cold start
// lazily imports the auth chain and can take ~40s. The JWT is cached for its
// whole lifetime afterwards, so the cold call gets a generous budget instead of
// eight consecutive 8s timeouts.
const OPERATOR_LOGIN_TIMEOUT_MS = 60_000;

let cachedOperatorJwt: { token: string; expiresAt: number } | null = null;
let cachedBackendEnv: Record<string, string> | null = null;

export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Env files in ascending priority; later files win. Missing files are skipped. */
const BACKEND_ENV_FILES = ['.env', 'python-service/.env', 'python-service/.env.local', '.env.local'];

function backendEnvFile(): Record<string, string> {
  if (cachedBackendEnv) return cachedBackendEnv;
  let merged: Record<string, string> = {};
  for (const rel of BACKEND_ENV_FILES) {
    try {
      const file = join(process.cwd(), rel);
      if (existsSync(file)) merged = { ...merged, ...parseEnvFile(readFileSync(file, 'utf-8')) };
    } catch {
      // Unreadable candidate — ignore and keep looking.
    }
  }
  cachedBackendEnv = merged;
  return cachedBackendEnv;
}

export function operatorCredentials(): { username: string; password: string } | null {
  const env = backendEnvFile();
  const username = (process.env.APP_USERNAME ?? env.APP_USERNAME ?? '').trim();
  const password = (process.env.APP_PASSWORD ?? env.APP_PASSWORD ?? '').trim();
  if (!username || !password) return null;
  return { username, password };
}

/** Exchange the configured operator credentials for a backend JWT.
 *  Returns null when no credentials are configured or the login fails. */
export async function acquireOperatorJwt(): Promise<string | null> {
  const creds = operatorCredentials();
  if (!creds) return null;

  if (cachedOperatorJwt && cachedOperatorJwt.expiresAt > Date.now() + OPERATOR_JWT_TTL_MS / 5) {
    return cachedOperatorJwt.token;
  }

  const res = await backendFetch('/api/user/login', {
    method: 'POST',
    body: JSON.stringify({ username: creds.username, password: creds.password }),
    timeoutMs: OPERATOR_LOGIN_TIMEOUT_MS,
  });
  if (!res.ok) return null;

  const token = String(res.data?.token ?? '');
  if (!token) return null;
  cachedOperatorJwt = { token, expiresAt: Date.now() + OPERATOR_JWT_TTL_MS };
  return token;
}
