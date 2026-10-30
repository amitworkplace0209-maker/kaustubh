import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { isIP } from 'net';
import { join } from 'path';
import type { NextRequest } from 'next/server';

/**
 * Server-only configuration for the single-owner auth system.
 *
 * Nothing in this file may be imported from a Client Component: it reads
 * secrets from disk/environment. `next.config.js` never inlines these values
 * because none use the `NEXT_PUBLIC_` prefix.
 */

const CWD = process.cwd();

/** Lowest priority first — later files win, then real process.env wins. */
function envFiles(): string[] {
  // Literal path segments keep Turbopack's tracing scoped to the two known
  // env directories instead of tracing the whole repository.
  return [
    join(CWD, 'python-service', '.env'),
    join(CWD, 'python-service', '.env.local'),
    join(CWD, '.env'),
    join(CWD, '.env.local'),
  ];
}

// Vercel's filesystem is immutable and never contains the gitignored backend
// env files. Credentials there come exclusively from project environment
// variables, so skip the disk fallback entirely.
const IS_VERCEL = Boolean(process.env.VERCEL);

export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      value.length > 1
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

let envCache: Record<string, string> | null = null;

function fileEnv(): Record<string, string> {
  if (envCache) return envCache;
  if (IS_VERCEL) {
    envCache = {};
    return envCache;
  }
  let merged: Record<string, string> = {};
  for (const file of envFiles()) {
    try {
      if (existsSync(/* turbopackIgnore: true */ file)) {
        merged = { ...merged, ...parseEnvFile(readFileSync(/* turbopackIgnore: true */ file, 'utf-8')) };
      }
    } catch {
      /* unreadable candidate — ignore */
    }
  }
  envCache = merged;
  return merged;
}

function str(key: string): string {
  const fromProcess = (process.env[key] ?? '').trim();
  if (fromProcess) return fromProcess;
  return (fileEnv()[key] ?? '').trim();
}

function bool(key: string, fallback = false): boolean {
  const value = str(key).toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function int(key: string, fallback: number): number {
  const parsed = Number.parseInt(str(key), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const isProduction = process.env.NODE_ENV === 'production';

/** Server-only Mongo URI. NEVER expose this through a NEXT_PUBLIC_ variable. */
export function getMongoUri(): string {
  return str('AUTH_MONGODB_URI') || str('MONGODB_URI');
}

export function getMongoDbName(): string {
  const explicit = str('AUTH_MONGODB_DB');
  if (explicit) return explicit;
  const uri = getMongoUri();
  if (uri) {
    try {
      const withoutQuery = uri.split('?')[0];
      const slash = withoutQuery.lastIndexOf('/');
      const name = slash >= 0 ? withoutQuery.slice(slash + 1) : '';
      if (name && !name.includes('@')) return decodeURIComponent(name);
    } catch {
      /* fall through */
    }
  }
  return 'kaustubh';
}

/** Owner bootstrap email — the signup form must match this value. */
export function getSignupEmail(): string {
  return str('AUTH_SIGNUP_EMAIL').toLowerCase();
}

/** Owner bootstrap MPIN — required to perform the one-time signup. */
export function getSignupMpin(): string {
  return str('AUTH_SIGNUP_MPIN');
}

export function getMaxActiveSessions(): number {
  const configured = int('AUTH_MAX_ACTIVE_SESSIONS', 2);
  return Math.min(Math.max(configured, 1), 2);
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

export function getSmtpConfig(): SmtpConfig | null {
  const host = str('AUTH_SMTP_HOST');
  const user = str('AUTH_SMTP_USER');
  const pass = str('AUTH_SMTP_PASS');
  if (!host || !user || !pass) return null;
  return {
    host,
    port: int('AUTH_SMTP_PORT', 587),
    secure: bool('AUTH_SMTP_SECURE', int('AUTH_SMTP_PORT', 587) === 465),
    user,
    pass,
    from: str('AUTH_EMAIL_FROM') || user,
    to: str('AUTH_EMAIL_TO') || getSignupEmail(),
  };
}

export function getOtpWebhookUrl(): string {
  return str('AUTH_OTP_WEBHOOK_URL');
}

export function mailerConfigured(): boolean {
  return Boolean(getSmtpConfig() || getOtpWebhookUrl());
}

/** Allow the OTP to be surfaced in dev only, so setup works without SMTP. */
export function allowDevOtp(): boolean {
  return !isProduction && bool('AUTH_OTP_DEV_FALLBACK', true);
}

/** Optional: list of allowed origins for WebAuthn (comma separated). */
export function getAllowedOrigins(): string[] {
  const raw = str('AUTH_ORIGIN');
  return raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

export function getRpName(): string {
  return str('AUTH_RP_NAME') || 'KAUSTUBH Trading Platform';
}

export interface RequestContext {
  ip: string | null;
  userAgent: string;
  origin: string;
  hostname: string;
  secure: boolean;
  deviceLabel: string;
}

function firstForwardedIp(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first || null;
}

function normalizeIp(candidate: string | null): string | null {
  if (!candidate) return null;
  let ip = candidate.trim();
  if (!ip) return null;
  // Strip surrounding quotes/brackets and an IPv4 :port suffix.
  ip = ip.replace(/^"|"$/g, '').replace(/^\[|\]$/g, '');
  if (ip.includes('.') && ip.includes(':')) {
    const maybePort = ip.slice(ip.lastIndexOf(':') + 1);
    if (/^\d+$/.test(maybePort)) ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  return isIP(ip) ? ip : null;
}

/**
 * Real client IP. Ordering matches the platforms this app is deployed on:
 * nginx/VM reverse proxy, Vercel, Cloudflare. In production a login without a
 * resolvable client IP is rejected (see the auth routes) — it is never
 * hardcoded.
 */
export function getClientIp(request: NextRequest): string | null {
  const headers = request.headers;
  const candidates = [
    firstForwardedIp(headers.get('x-forwarded-for')),
    headers.get('x-real-ip'),
    headers.get('cf-connecting-ip'),
    firstForwardedIp(headers.get('x-vercel-forwarded-for')),
    headers.get('x-client-ip'),
    headers.get('true-client-ip'),
  ];
  for (const candidate of candidates) {
    const ip = normalizeIp(candidate);
    if (ip) return ip;
  }
  // Local development has no proxy headers; loopback is the honest answer.
  if (!isProduction) return '127.0.0.1';
  return null;
}

export function describeUserAgent(ua: string): string {
  const value = ua || '';
  const browser =
    /Edg\//.test(value) ? 'Edge'
      : /OPR\//.test(value) ? 'Opera'
        : /Chrome\//.test(value) ? 'Chrome'
          : /Firefox\//.test(value) ? 'Firefox'
            : /Safari\//.test(value) ? 'Safari'
              : 'Browser';
  const os =
    /iPhone|iPad|iPod/.test(value) ? 'iOS'
      : /Android/.test(value) ? 'Android'
        : /Windows/.test(value) ? 'Windows'
          : /Mac OS X/.test(value) ? 'macOS'
            : /Linux/.test(value) ? 'Linux'
              : 'Device';
  const pwa = /standalone|KAUSTUBH-PWA/i.test(value) ? 'PWA' : '';
  return [browser, os, pwa].filter(Boolean).join(' · ');
}

export function requestContext(request: NextRequest): RequestContext {
  const forwardedProto = (request.headers.get('x-forwarded-proto') || '').split(',')[0]?.trim().toLowerCase();
  const host = request.headers.get('host') || request.nextUrl.host || 'localhost';
  const secure = forwardedProto ? forwardedProto === 'https' : request.nextUrl.protocol === 'https:';
  const origin = getAllowedOrigins()[0] || `${secure ? 'https' : 'http'}://${host}`;
  const hostname = host.replace(/^\[|\]$/g, '').split(':')[0] || 'localhost';
  return {
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent') || 'unknown',
    origin,
    hostname,
    secure,
    deviceLabel: describeUserAgent(request.headers.get('user-agent') || ''),
  };
}

export function getRpId(request: NextRequest): string {
  const explicit = str('AUTH_RP_ID');
  if (explicit) return explicit;
  return requestContext(request).hostname;
}

export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!name || !domain) return 'your email';
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(1, name.length - visible.length))}@${domain}`;
}

export function publicIp(ip: string | null): string {
  return ip || 'unknown';
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 16);
}
