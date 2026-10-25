import { hashSecret, verifySecret } from '@/lib/auth-crypto';
import { updateOwner, type AuthUserDoc } from '@/lib/auth-db';
import { validateMpin } from '@/lib/auth-validation';

/**
 * MPIN policy + lockout. The MPIN is a 6-digit app-lock code hashed with scrypt;
 * it is separate from the account password and can be replaced by (or combined
 * with) a real WebAuthn fingerprint credential in Settings → Security.
 */

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

export interface MpinCheck {
  ok: boolean;
  message?: string;
  status?: number;
  lockedUntil?: number;
}

export function mpinLockRemainingMs(user: AuthUserDoc): number {
  const until = Number(user.mpinLockedUntil ?? 0);
  return until > Date.now() ? until - Date.now() : 0;
}

export async function verifyOwnerMpin(user: AuthUserDoc, mpin: unknown): Promise<MpinCheck> {
  if (!user.mpinHash) {
    return { ok: false, message: 'No MPIN is configured for this account.', status: 409 };
  }

  const remaining = mpinLockRemainingMs(user);
  if (remaining > 0) {
    return {
      ok: false,
      message: `Too many incorrect MPIN attempts. Try again in ${Math.ceil(remaining / 60_000)} minute(s).`,
      status: 429,
      lockedUntil: user.mpinLockedUntil ?? undefined,
    };
  }

  const value = String(mpin ?? '');
  if (!/^\d{6}$/.test(value)) {
    return { ok: false, message: 'MPIN must be exactly 6 digits.', status: 400 };
  }

  const valid = await verifySecret(value, user.mpinHash);
  if (!valid) {
    const attempts = Number(user.mpinFailedAttempts ?? 0) + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;
    await updateOwner({
      mpinFailedAttempts: lock ? 0 : attempts,
      mpinLockedUntil: lock ? Date.now() + LOCK_MS : null,
    });
    return {
      ok: false,
      message: lock
        ? 'Too many incorrect MPIN attempts. Locked for 5 minutes.'
        : `Incorrect MPIN. ${MAX_FAILED_ATTEMPTS - attempts} attempt(s) left.`,
      status: lock ? 429 : 401,
    };
  }

  if (Number(user.mpinFailedAttempts ?? 0) > 0 || user.mpinLockedUntil) {
    await updateOwner({ mpinFailedAttempts: 0, mpinLockedUntil: null });
  }
  return { ok: true };
}

export async function setOwnerMpin(mpin: unknown): Promise<MpinCheck> {
  const error = validateMpin(mpin);
  if (error) return { ok: false, message: error, status: 400 };
  const hash = await hashSecret(String(mpin));
  await updateOwner({
    mpinHash: hash,
    mpinUpdatedAt: new Date().toISOString(),
    mpinFailedAttempts: 0,
    mpinLockedUntil: null,
  });
  return { ok: true };
}

export async function clearOwnerMpin(): Promise<void> {
  await updateOwner({
    mpinHash: null,
    mpinUpdatedAt: null,
    mpinFailedAttempts: 0,
    mpinLockedUntil: null,
  });
}
