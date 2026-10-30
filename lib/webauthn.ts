import type { NextRequest } from 'next/server';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { backendAuthJson } from '@/lib/auth-proxy';
import { getAllowedOrigins, getRpId, getRpName, requestContext } from '@/lib/auth-config';

/**
 * Real WebAuthn (passkey / fingerprint / face) support.
 *
 * The cryptography stays in this Node layer (`@simplewebauthn/server`), but all
 * persistent state — credentials, one-time challenges and signature counters —
 * lives in MongoDB behind the VM1 backend. Vercel has no database credentials,
 * so every storage operation calls the session-gated data-plane endpoints under
 * `/api/auth/webauthn/*` with the browser's own cookies. The browser only ever
 * receives public options — never a secret.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface WebAuthnContext {
  rpID: string;
  rpName: string;
  expectedOrigin: string[];
  origin: string;
}

interface StoredCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceLabel: string;
}

function devOriginAliases(origin: string): string[] {
  // Local development is commonly opened via 127.0.0.1 even though WebAuthn
  // RP IDs must be `localhost`. Accept both origins so a dev machine is not
  // forced to edit its URL, while the RP ID itself stays `localhost`.
  try {
    const url = new URL(origin);
    if (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1') {
      const alias = new URL(origin);
      alias.hostname = 'localhost';
      return [alias.origin];
    }
    if (url.hostname === 'localhost') {
      const alias = new URL(origin);
      alias.hostname = '127.0.0.1';
      return [alias.origin];
    }
  } catch {
    /* not a URL — ignore */
  }
  return [];
}

export function webAuthnContext(request: NextRequest): WebAuthnContext {
  const ctx = requestContext(request);
  const configured = getAllowedOrigins();
  const origins = configured.length ? configured : [ctx.origin];
  const expectedOrigin = Array.from(new Set([...origins, ...origins.flatMap(devOriginAliases)]));
  return {
    rpID: getRpId(request),
    rpName: getRpName(),
    expectedOrigin,
    origin: origins[0],
  };
}

export function assertWebAuthnSupported(context: WebAuthnContext): string | null {
  if (!context.rpID) return 'Cannot determine the WebAuthn relying-party ID for this host.';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(context.rpID) || context.rpID.includes(':')) {
    return 'Biometric sign-in needs a domain name (or localhost). Open the app on its domain, or set AUTH_RP_ID/AUTH_ORIGIN.';
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Backend data plane (VM1 owns MongoDB; Vercel owns the WebAuthn crypto).
 * ---------------------------------------------------------------------- */

function backendFailure(action: string, status: number): Error {
  if (status === 401 || status === 403) {
    return new Error('Your session has expired. Please log in again.');
  }
  if (status === 503 || status === 0) {
    return new Error('The authentication service is unavailable right now. Retry in a moment.');
  }
  return new Error(`${action} failed. Please try again.`);
}

async function fetchCredentials(request: NextRequest): Promise<StoredCredential[]> {
  const result = await backendAuthJson(request, '/api/auth/webauthn/credentials', { method: 'GET' });
  if (!result.response || !result.ok) {
    throw backendFailure('Loading biometric credentials', result.status);
  }
  const data = (result.data || {}) as { credentials?: unknown };
  if (!Array.isArray(data.credentials)) return [];
  return data.credentials
    .filter((cred): cred is Record<string, unknown> => Boolean(cred) && typeof cred === 'object')
    .map((cred) => ({
      credentialId: String(cred.id ?? ''),
      publicKey: String(cred.publicKey ?? ''),
      counter: Number(cred.counter ?? 0) || 0,
      transports: Array.isArray(cred.transports) ? cred.transports.map(String) : [],
      deviceLabel: String(cred.deviceLabel ?? ''),
    }))
    .filter((cred) => Boolean(cred.credentialId) && Boolean(cred.publicKey));
}

async function fetchCredential(
  request: NextRequest,
  credentialId: string,
): Promise<StoredCredential | null> {
  const credentials = await fetchCredentials(request);
  return credentials.find((cred) => cred.credentialId === credentialId) ?? null;
}

async function saveChallenge(
  request: NextRequest,
  challenge: string,
  type: 'registration' | 'authentication',
): Promise<void> {
  const result = await backendAuthJson(request, '/api/auth/webauthn/challenge', {
    method: 'POST',
    body: JSON.stringify({ challenge, type }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (!result.response || !result.ok) {
    throw backendFailure('Saving the WebAuthn challenge', result.status);
  }
}

async function takeChallenge(
  request: NextRequest,
  type: 'registration' | 'authentication',
): Promise<string | null> {
  const result = await backendAuthJson(request, '/api/auth/webauthn/challenge/take', {
    method: 'POST',
    body: JSON.stringify({ type }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (!result.response || !result.ok) {
    throw backendFailure('Consuming the WebAuthn challenge', result.status);
  }
  const challenge = String((result.data as { challenge?: unknown } | null)?.challenge ?? '');
  return challenge || null;
}

async function recordBiometricEvent(
  request: NextRequest,
  payload: { credentialId?: string; counter?: number; success: boolean; detail?: string },
): Promise<void> {
  // Best effort: the WebAuthn result must not be discarded because the audit
  // write failed. The next login re-verifies liveness anyway.
  await backendAuthJson(request, '/api/auth/webauthn/counters', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
  }).catch(() => undefined);
}

/* -------------------------------------------------------------------------
 * Registration / authentication flows.
 * ---------------------------------------------------------------------- */

function toCredential(doc: StoredCredential) {
  return {
    id: doc.credentialId,
    publicKey: Buffer.from(doc.publicKey, 'base64url'),
    counter: doc.counter,
    transports: doc.transports,
  };
}

export async function registrationOptions(options: {
  request: NextRequest;
  userId: string;
  userName: string;
  userDisplayName: string;
}) {
  const context = webAuthnContext(options.request);
  const unsupported = assertWebAuthnSupported(context);
  if (unsupported) return { ok: false as const, message: unsupported };

  const existing = await fetchCredentials(options.request);
  const generated = await generateRegistrationOptions({
    rpName: context.rpName,
    rpID: context.rpID,
    userName: options.userName,
    userDisplayName: options.userDisplayName,
    userID: new TextEncoder().encode(options.userId),
    attestationType: 'none',
    excludeCredentials: existing.map((cred) => ({
      id: cred.credentialId,
      transports: cred.transports,
    })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required',
    },
    timeout: CHALLENGE_TTL_MS,
  });

  await saveChallenge(options.request, generated.challenge, 'registration');

  return { ok: true as const, options: generated };
}

export type RegistrationVerification =
  | { ok: true; credentialId: string; publicKey: string; counter: number; transports: string[] }
  | { ok: false; message: string };

export async function verifyRegistration(options: {
  request: NextRequest;
  response: RegistrationResponseJSON;
}): Promise<RegistrationVerification> {
  const context = webAuthnContext(options.request);
  const unsupported = assertWebAuthnSupported(context);
  if (unsupported) return { ok: false, message: unsupported };

  let challenge: string | null;
  try {
    challenge = await takeChallenge(options.request, 'registration');
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not load the challenge.' };
  }
  if (!challenge) return { ok: false, message: 'This registration challenge expired. Please try again.' };

  try {
    const verification = await verifyRegistrationResponse({
      response: options.response,
      expectedChallenge: challenge,
      expectedOrigin: context.expectedOrigin,
      expectedRPID: context.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return { ok: false, message: 'The biometric registration could not be verified.' };
    }
    const { credential } = verification.registrationInfo;
    return {
      ok: true,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? [],
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'The biometric registration could not be verified.',
    };
  }
}

export async function authenticationOptions(options: {
  request: NextRequest;
  userId: string;
}) {
  const context = webAuthnContext(options.request);
  const unsupported = assertWebAuthnSupported(context);
  if (unsupported) return { ok: false as const, message: unsupported };

  let credentials: StoredCredential[];
  try {
    credentials = await fetchCredentials(options.request);
  } catch (err) {
    return { ok: false as const, message: err instanceof Error ? err.message : 'Could not load biometric credentials.' };
  }
  if (!credentials.length) {
    return { ok: false as const, message: 'No biometric credential is registered on this account yet.' };
  }

  const generated = await generateAuthenticationOptions({
    rpID: context.rpID,
    allowCredentials: credentials.map((cred) => ({
      id: cred.credentialId,
      transports: cred.transports,
    })),
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
  });

  await saveChallenge(options.request, generated.challenge, 'authentication');

  return { ok: true as const, options: generated };
}

export type AuthenticationVerification =
  | { ok: true; credentialId: string }
  | { ok: false; message: string };

export async function verifyAuthentication(options: {
  request: NextRequest;
  response: AuthenticationResponseJSON;
}): Promise<AuthenticationVerification> {
  const context = webAuthnContext(options.request);
  const unsupported = assertWebAuthnSupported(context);
  if (unsupported) return { ok: false, message: unsupported };

  let challenge: string | null;
  try {
    challenge = await takeChallenge(options.request, 'authentication');
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not load the challenge.' };
  }
  if (!challenge) return { ok: false, message: 'This biometric challenge expired. Please try again.' };

  const credentialId = String(options.response?.id ?? '');
  if (!credentialId) return { ok: false, message: 'The biometric response is missing a credential id.' };

  let stored: StoredCredential | null;
  try {
    stored = await fetchCredential(options.request, credentialId);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not load the credential.' };
  }
  if (!stored) return { ok: false, message: 'That biometric credential is not registered on this account.' };

  try {
    const verification = await verifyAuthenticationResponse({
      response: options.response,
      expectedChallenge: challenge,
      expectedOrigin: context.expectedOrigin,
      expectedRPID: context.rpID,
      credential: toCredential(stored),
      requireUserVerification: true,
    });
    if (!verification.verified) {
      await recordBiometricEvent(options.request, {
        credentialId: stored.credentialId,
        success: false,
        detail: 'Biometric verification failed',
      });
      return { ok: false, message: 'The biometric verification failed.' };
    }
    await recordBiometricEvent(options.request, {
      credentialId: stored.credentialId,
      counter: verification.authenticationInfo.newCounter,
      success: true,
      detail: 'App unlocked with biometrics',
    });
    return { ok: true, credentialId: stored.credentialId };
  } catch (err) {
    await recordBiometricEvent(options.request, {
      credentialId: stored.credentialId,
      success: false,
      detail: err instanceof Error ? err.message.slice(0, 200) : 'Biometric verification failed',
    });
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'The biometric verification failed.',
    };
  }
}
