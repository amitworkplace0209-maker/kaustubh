import { createHash, createHmac, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const scryptAsync = promisify(scrypt) as unknown as (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const CONFIG_DIR = join(process.cwd(), '.auth');
const CONFIG_FILE = join(CONFIG_DIR, 'app-lock.json');
const SESSION_SECRET_FILE = join(CONFIG_DIR, 'session-secret');

// --------------------------------------------------------------- legacy PIN

export interface AppLockConfig {
  pinHash: string;
  pinSalt: string;
  createdAt: string;
}

export function hashPin(pin: string, salt: string): string {
  return createHash('sha256').update(pin + salt).digest('hex');
}

export function generateSalt(): string {
  return randomBytes(16).toString('hex');
}

export function constantTimeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function loadConfig(): Promise<AppLockConfig | null> {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    return JSON.parse(await readFile(CONFIG_FILE, 'utf-8')) as AppLockConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: AppLockConfig): Promise<void> {
  if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export async function removeConfig(): Promise<void> {
  const { unlink } = await import('fs/promises');
  if (existsSync(CONFIG_FILE)) await unlink(CONFIG_FILE);
}

// ------------------------------------------------------------- passwords

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/**
 * Password + MPIN hashing. scrypt with a per-secret random salt. The stored
 * format carries the parameters so future cost upgrades stay verifiable.
 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derived = (await scryptAsync(secret.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString('base64url')}`;
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, salt, expected] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const derived = (await scryptAsync(secret.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    })) as Buffer;
    const wanted = Buffer.from(expected, 'base64url');
    if (derived.length !== wanted.length) return false;
    return timingSafeEqual(derived, wanted);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ OTP

export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashOtp(otp: string, salt: string): string {
  return createHmac('sha256', resolveSessionSecret()).update(`${salt}:${otp}`).digest('base64url');
}

export function verifyOtp(otp: string, salt: string, expected: string): boolean {
  return constantTimeCompare(hashOtp(otp, salt), expected);
}

// --------------------------------------------------------- session token

let sessionSecretCache: string | null = null;

function resolveSessionSecret(): string {
  if (sessionSecretCache) return sessionSecretCache;

  const fromEnv = (process.env.AUTH_SESSION_SECRET || process.env.APP_SESSION_SECRET || '').trim();
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
    /* fall through */
  }

  // Keep this module self-contained: the Node test runner imports it directly
  // (no `@/` path alias). The resolution order matches `lib/auth-config.ts` and
  // `server.mjs` exactly: env → `.auth/session-secret` → generate once.
  let generated = randomBytes(48).toString('hex');
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    try {
      writeFileSync(SESSION_SECRET_FILE, generated, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    } catch (err) {
      // Another process (Next or server.mjs) won the race — use its secret.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const stored = readFileSync(SESSION_SECRET_FILE, 'utf-8').trim();
    if (stored.length >= 32) generated = stored;
  } catch {
    /* read-only FS — keep the in-memory secret */
  }
  sessionSecretCache = generated;
  return sessionSecretCache;
}

function signPayload(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export interface SessionPayload {
  authenticated: true;
  /** Session record id (MongoDB `app_auth_sessions.sessionId`). */
  sid?: string;
  /** Browser device id (localStorage), used for one-login-per-place policy. */
  did?: string;
  iat: number;
  exp: number;
  v?: number;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'kaustubh_session';
export const MPIN_PENDING_COOKIE = 'kaustubh_mpin_pending';

export interface CreateSessionTokenOptions {
  sessionId?: string;
  deviceId?: string;
  ttlMs?: number;
  issuedAt?: number;
}

export function createSessionToken(options: CreateSessionTokenOptions = {}): string {
  const iat = options.issuedAt ?? Date.now();
  const payload: SessionPayload = {
    v: 2,
    authenticated: true,
    sid: options.sessionId ?? randomUUID(),
    did: options.deviceId ?? '',
    iat,
    exp: iat + (options.ttlMs ?? SESSION_TTL_MS),
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

export function newId(): string {
  return randomUUID();
}

export function newDeviceId(): string {
  return `dev_${randomBytes(12).toString('base64url')}`;
}
