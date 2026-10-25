import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const CONFIG_DIR = join(process.cwd(), '.auth');
const CONFIG_FILE = join(CONFIG_DIR, 'app-lock.json');
const SESSION_SECRET_FILE = join(CONFIG_DIR, 'session-secret');

export interface AppLockConfig {
  pinHash: string;
  pinSalt: string;
  createdAt: string;
}

export function hashPin(pin: string, salt: string): string {
  return createHash('sha256').update(pin + salt).digest('hex');
}

export function generateSalt(): string {
  return createHash('sha256').update(String(Date.now()) + String(Math.random())).digest('hex').slice(0, 16);
}

export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function loadConfig(): Promise<AppLockConfig | null> {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveConfig(config: AppLockConfig): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export async function removeConfig(): Promise<void> {
  const { unlink } = await import('fs/promises');
  if (existsSync(CONFIG_FILE)) {
    await unlink(CONFIG_FILE);
  }
}

// ---------------------------------------------------------------------------
// App session token (HMAC-signed)
//
// The cookie used to be a bare base64 JSON blob, so anyone could hand-craft
// `{"authenticated":true,"exp":<future>}` and pass every session check. The
// payload is now signed with a server-only secret and MUST be verified through
// `verifySessionToken` — never by base64-decoding it.
// ---------------------------------------------------------------------------

let sessionSecretCache: string | null = null;

function resolveSessionSecret(): string {
  if (sessionSecretCache) return sessionSecretCache;

  const fromEnv = (process.env.APP_SESSION_SECRET ?? '').trim();
  if (fromEnv.length >= 32) {
    sessionSecretCache = fromEnv;
    return sessionSecretCache;
  }

  try {
    if (existsSync(SESSION_SECRET_FILE)) {
      const stored = readFileSync(SESSION_SECRET_FILE, 'utf-8').trim();
      if (stored.length >= 32) {
        sessionSecretCache = stored;
        return sessionSecretCache;
      }
    }
  } catch {
    // Unreadable/absent secret file — fall through to generating one.
  }

  const generated = randomBytes(32).toString('hex');
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(SESSION_SECRET_FILE, generated, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Read-only filesystem: keep an in-process secret. Signing still works but
    // sessions do not survive a server restart, which fails closed (401).
  }
  sessionSecretCache = generated;
  return sessionSecretCache;
}

function signPayload(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export interface SessionPayload {
  authenticated: true;
  iat: number;
  exp: number;
}

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function createSessionToken(): string {
  const payload: SessionPayload = {
    authenticated: true,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${signPayload(encoded, resolveSessionSecret())}`;
}

export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  const expected = signPayload(encoded, resolveSessionSecret());
  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
    if (!payload || payload.authenticated !== true) return null;
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Date.now()) return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}
