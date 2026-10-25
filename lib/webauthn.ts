import type { NextRequest } from 'next/server';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { getAllowedOrigins, getRpId, getRpName, requestContext } from '@/lib/auth-config';
import {
  getCredential,
  listCredentials,
  saveChallenge,
  takeChallenge,
  updateCredentialCounter,
  type WebAuthnCredentialDoc,
} from '@/lib/auth-db';

/**
 * Real WebAuthn (passkey / fingerprint / face) support.
 *
 * Challenges are generated server-side, persisted in MongoDB with a short TTL,
 * and consumed exactly once by the matching verify call. The browser only ever
 * receives public options — never a secret.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface WebAuthnContext {
  rpID: string;
  rpName: string;
  expectedOrigin: string[];
  origin: string;
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

function toCredential(doc: WebAuthnCredentialDoc) {
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

  const existing = await listCredentials(options.userId);
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

  await saveChallenge({
    challenge: generated.challenge,
    type: 'registration',
    userId: options.userId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

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

  const challenge = await takeChallenge('registration');
  if (!challenge) return { ok: false, message: 'This registration challenge expired. Please try again.' };

  try {
    const verification = await verifyRegistrationResponse({
      response: options.response,
      expectedChallenge: challenge.challenge,
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

  const credentials = await listCredentials(options.userId);
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

  await saveChallenge({
    challenge: generated.challenge,
    type: 'authentication',
    userId: options.userId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

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

  const challenge = await takeChallenge('authentication');
  if (!challenge) return { ok: false, message: 'This biometric challenge expired. Please try again.' };

  const credentialId = String(options.response?.id ?? '');
  if (!credentialId) return { ok: false, message: 'The biometric response is missing a credential id.' };

  const stored = await getCredential(credentialId);
  if (!stored) return { ok: false, message: 'That biometric credential is not registered on this account.' };

  try {
    const verification = await verifyAuthenticationResponse({
      response: options.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: context.expectedOrigin,
      expectedRPID: context.rpID,
      credential: toCredential(stored),
      requireUserVerification: true,
    });
    if (!verification.verified) {
      return { ok: false, message: 'The biometric verification failed.' };
    }
    await updateCredentialCounter(stored.credentialId, verification.authenticationInfo.newCounter);
    return { ok: true, credentialId: stored.credentialId };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'The biometric verification failed.',
    };
  }
}
