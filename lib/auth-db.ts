import { MongoClient, type Db, type Collection, type ObjectId } from 'mongodb';
import dns from 'node:dns/promises';
import { getMongoDbName, getMongoUri } from '@/lib/auth-config';

/**
 * MongoDB persistence for the single-owner auth system.
 *
 * Why MongoDB (and not a JSON file): the app is deployed to Vercel (serverless,
 * read-only filesystem) and to a VM. MongoDB is the database the project already
 * uses. On a fresh VM database the owner collection is empty, so the one-time
 * signup screen appears automatically.
 */

export interface AuthUserDoc {
  _id?: ObjectId;
  singleton: 'owner';
  name: string;
  nameLower: string;
  email: string;
  emailLower: string;
  passwordHash: string;
  mpinHash?: string | null;
  mpinUpdatedAt?: string | null;
  mpinFailedAttempts?: number;
  mpinLockedUntil?: number | null;
  passwordFailedAttempts?: number;
  passwordLockedUntil?: number | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string | null;
}

export interface AuthSessionDoc {
  _id?: ObjectId;
  sessionId: string;
  userId: string;
  deviceId: string;
  deviceLabel: string;
  ip: string;
  userAgent: string;
  kind: 'primary' | 'secondary';
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason?: string | null;
}

export type AuthEventType =
  | 'signup'
  | 'login'
  | 'login_failed'
  | 'login_otp_requested'
  | 'login_otp_verified'
  | 'login_otp_failed'
  | 'logout'
  | 'logout_all'
  | 'device_revoked'
  | 'mpin_setup'
  | 'mpin_verified'
  | 'mpin_failed'
  | 'mpin_changed'
  | 'mpin_removed'
  | 'biometric_registered'
  | 'biometric_removed'
  | 'biometric_login'
  | 'biometric_failed';

export interface AuthEventDoc {
  _id?: ObjectId;
  type: AuthEventType;
  userId?: string | null;
  ip: string;
  userAgent: string;
  deviceId?: string | null;
  deviceLabel?: string | null;
  sessionId?: string | null;
  success: boolean;
  detail?: string | null;
  at: Date;
}

export interface PendingLoginDoc {
  _id?: ObjectId;
  pendingId: string;
  userId: string;
  deviceId: string;
  deviceLabel: string;
  ip: string;
  userAgent: string;
  otpSalt: string;
  otpHash: string;
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
  status: 'pending' | 'approved' | 'expired' | 'denied';
}

export interface WebAuthnCredentialDoc {
  _id?: ObjectId;
  credentialId: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  deviceLabel: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface WebAuthnChallengeDoc {
  _id?: ObjectId;
  challenge: string;
  type: 'registration' | 'authentication';
  userId?: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export class AuthDatabaseError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AuthDatabaseError';
  }
}

const globalRef = globalThis as unknown as {
  __kaustubhAuthMongo?: Promise<MongoClient>;
  __kaustubhAuthIndexes?: Promise<void>;
  __kaustubhAuthDbName?: string;
};

async function directUriFromSrv(srvUri: string): Promise<string> {
  const url = new URL(srvUri.replace(/^mongodb\+srv:\/\//, 'https://'));
  const host = url.hostname;
  const resolver = new dns.Resolver();
  // Some Windows/sandbox DNS setups refuse SRV queries through the default
  // resolver while public DNS answers them. The fallback keeps local dev and
  // restricted VMs working; normal hosts never reach this path.
  resolver.setServers(['8.8.8.8', '1.1.1.1']);
  const [records, txt] = await Promise.all([
    resolver.resolveSrv(`_mongodb._tcp.${host}`),
    resolver.resolveTxt(host).catch(() => [] as string[][]),
  ]);
  if (!records.length) throw new Error('SRV lookup returned no MongoDB hosts');
  const txtParams = new URLSearchParams(txt.flat().join('&'));
  const params = new URLSearchParams(url.search);
  params.set('ssl', 'true');
  params.set('authSource', txtParams.get('authSource') || 'admin');
  const replicaSet = txtParams.get('replicaSet');
  if (replicaSet) params.set('replicaSet', replicaSet);
  const hosts = records.map((r) => `${r.name}:${r.port}`).join(',');
  return `mongodb://${url.username}:${url.password}@${hosts}${url.pathname}?${params.toString()}`;
}

function connectWith(uri: string): Promise<MongoClient> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 12_000,
    connectTimeoutMS: 12_000,
    maxPoolSize: 5,
    retryWrites: true,
  });
  return client.connect();
}

async function connectClient(): Promise<MongoClient> {
  const uri = getMongoUri();
  if (!uri) {
    throw new AuthDatabaseError(
      'MongoDB is not configured. Add MONGODB_URI (or AUTH_MONGODB_URI) to .env.local / python-service/.env.',
    );
  }
  try {
    return await connectWith(uri);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const srvProblem = /querySrv|ECONNREFUSED|ESERVFAIL|ENOTFOUND|ETIMEOUT/i.test(message);
    if (uri.startsWith('mongodb+srv://') && srvProblem) {
      try {
        return await connectWith(await directUriFromSrv(uri));
      } catch (fallbackErr) {
        throw new AuthDatabaseError(`MongoDB connection failed: ${message}`, fallbackErr);
      }
    }
    throw new AuthDatabaseError(`MongoDB connection failed: ${message}`, err);
  }
}

export function getMongoClient(): Promise<MongoClient> {
  if (!globalRef.__kaustubhAuthMongo) {
    globalRef.__kaustubhAuthMongo = connectClient().catch((err) => {
      globalRef.__kaustubhAuthMongo = undefined;
      throw err;
    });
  }
  return globalRef.__kaustubhAuthMongo;
}

export async function getAuthDb(): Promise<Db> {
  const client = await getMongoClient();
  const name = getMongoDbName();
  globalRef.__kaustubhAuthDbName = name;
  const db = client.db(name);
  if (!globalRef.__kaustubhAuthIndexes) {
    globalRef.__kaustubhAuthIndexes = ensureIndexes(db).catch((err) => {
      globalRef.__kaustubhAuthIndexes = undefined;
      throw err;
    });
  }
  await globalRef.__kaustubhAuthIndexes;
  return db;
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection<AuthUserDoc>('app_auth_users').createIndex({ singleton: 1 }, { unique: true }),
    db.collection<AuthUserDoc>('app_auth_users').createIndex({ nameLower: 1 }, { unique: true }),
    db.collection<AuthUserDoc>('app_auth_users').createIndex({ emailLower: 1 }, { unique: true }),
    db.collection<AuthSessionDoc>('app_auth_sessions').createIndex({ sessionId: 1 }, { unique: true }),
    db.collection<AuthSessionDoc>('app_auth_sessions').createIndex({ userId: 1, revokedAt: 1, expiresAt: 1 }),
    db.collection<AuthSessionDoc>('app_auth_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection<AuthEventDoc>('app_auth_events').createIndex({ at: -1 }),
    db.collection<AuthEventDoc>('app_auth_events').createIndex({ ip: 1, type: 1, at: -1 }),
    db.collection<PendingLoginDoc>('app_auth_pending_logins').createIndex({ pendingId: 1 }, { unique: true }),
    db.collection<PendingLoginDoc>('app_auth_pending_logins').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection<WebAuthnCredentialDoc>('app_auth_webauthn').createIndex({ credentialId: 1 }, { unique: true }),
    db.collection<WebAuthnCredentialDoc>('app_auth_webauthn').createIndex({ userId: 1 }),
    db.collection<WebAuthnChallengeDoc>('app_auth_webauthn_challenges').createIndex({ challenge: 1 }, { unique: true }),
    db.collection<WebAuthnChallengeDoc>('app_auth_webauthn_challenges').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

async function users(): Promise<Collection<AuthUserDoc>> {
  return (await getAuthDb()).collection<AuthUserDoc>('app_auth_users');
}
async function sessions(): Promise<Collection<AuthSessionDoc>> {
  return (await getAuthDb()).collection<AuthSessionDoc>('app_auth_sessions');
}
async function events(): Promise<Collection<AuthEventDoc>> {
  return (await getAuthDb()).collection<AuthEventDoc>('app_auth_events');
}
async function pending(): Promise<Collection<PendingLoginDoc>> {
  return (await getAuthDb()).collection<PendingLoginDoc>('app_auth_pending_logins');
}
async function credentials(): Promise<Collection<WebAuthnCredentialDoc>> {
  return (await getAuthDb()).collection<WebAuthnCredentialDoc>('app_auth_webauthn');
}
async function challenges(): Promise<Collection<WebAuthnChallengeDoc>> {
  return (await getAuthDb()).collection<WebAuthnChallengeDoc>('app_auth_webauthn_challenges');
}

// ---------------------------------------------------------------- users

export async function hasOwner(): Promise<boolean> {
  return (await (await users()).countDocuments({ singleton: 'owner' }, { limit: 1 })) > 0;
}

export async function getOwner(): Promise<AuthUserDoc | null> {
  return (await users()).findOne({ singleton: 'owner' });
}

export async function createOwner(user: AuthUserDoc): Promise<AuthUserDoc> {
  const col = await users();
  const result = await col.insertOne(user);
  return { ...user, _id: result.insertedId };
}

export async function updateOwner(update: Partial<AuthUserDoc>): Promise<void> {
  await (await users()).updateOne(
    { singleton: 'owner' },
    { $set: { ...update, updatedAt: new Date().toISOString() } },
  );
}

// ------------------------------------------------------------- sessions

export async function createSessionDoc(doc: AuthSessionDoc): Promise<AuthSessionDoc> {
  await (await sessions()).insertOne(doc);
  return doc;
}

export async function getSessionDoc(sessionId: string): Promise<AuthSessionDoc | null> {
  if (!sessionId) return null;
  return (await sessions()).findOne({ sessionId });
}

export async function listActiveSessions(userId: string): Promise<AuthSessionDoc[]> {
  return (await sessions())
    .find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function touchSession(sessionId: string, previous: Date): Promise<void> {
  // Throttle writes: lastSeenAt granularity of one minute is enough for UI.
  if (Date.now() - previous.getTime() < 60_000) return;
  await (await sessions()).updateOne({ sessionId }, { $set: { lastSeenAt: new Date() } });
}

export async function revokeSessionDoc(sessionId: string, reason = 'logout'): Promise<boolean> {
  const result = await (await sessions()).updateOne(
    { sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return result.modifiedCount > 0;
}

export async function revokeAllSessionDocs(userId: string, exceptSessionId?: string): Promise<number> {
  const filter: Record<string, unknown> = { userId, revokedAt: null };
  if (exceptSessionId) filter.sessionId = { $ne: exceptSessionId };
  const result = await (await sessions()).updateMany(filter, {
    $set: { revokedAt: new Date(), revokedReason: 'logout_all' },
  });
  return result.modifiedCount;
}

// --------------------------------------------------------------- events

export async function recordAuthEvent(event: Omit<AuthEventDoc, 'at'> & { at?: Date }): Promise<void> {
  try {
    await (await events()).insertOne({ ...event, at: event.at ?? new Date() });
  } catch {
    // Audit logging must never break a login. The session itself is still safe.
  }
}

export async function listAuthEvents(limit = 25): Promise<AuthEventDoc[]> {
  const safe = Math.min(Math.max(limit, 1), 100);
  return (await events()).find({}).sort({ at: -1 }).limit(safe).toArray();
}

// -------------------------------------------------------------- pending

export async function createPendingDoc(doc: PendingLoginDoc): Promise<void> {
  await (await pending()).insertOne(doc);
}

export async function getPendingDoc(pendingId: string): Promise<PendingLoginDoc | null> {
  return (await pending()).findOne({ pendingId });
}

export async function incrementPendingAttempts(pendingId: string): Promise<void> {
  await (await pending()).updateOne({ pendingId }, { $inc: { attempts: 1 } });
}

export async function resolvePendingDoc(
  pendingId: string,
  status: PendingLoginDoc['status'],
): Promise<void> {
  await (await pending()).updateOne({ pendingId }, { $set: { status } });
}

export async function listPendingDocs(): Promise<PendingLoginDoc[]> {
  return (await pending())
    .find({ status: 'pending', expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .toArray();
}

// ------------------------------------------------------------- webauthn

export async function listCredentials(userId: string): Promise<WebAuthnCredentialDoc[]> {
  return (await credentials()).find({ userId }).sort({ createdAt: 1 }).toArray();
}

export async function getCredential(credentialId: string): Promise<WebAuthnCredentialDoc | null> {
  return (await credentials()).findOne({ credentialId });
}

export async function addCredential(doc: WebAuthnCredentialDoc): Promise<void> {
  await (await credentials()).insertOne(doc);
}

export async function updateCredentialCounter(credentialId: string, counter: number): Promise<void> {
  await (await credentials()).updateOne(
    { credentialId },
    { $set: { counter, lastUsedAt: new Date() } },
  );
}

export async function removeCredential(credentialId: string, userId: string): Promise<boolean> {
  const result = await (await credentials()).deleteOne({ credentialId, userId });
  return result.deletedCount > 0;
}

export async function saveChallenge(doc: WebAuthnChallengeDoc): Promise<void> {
  await (await challenges()).insertOne(doc);
}

export async function takeChallenge(
  type: WebAuthnChallengeDoc['type'],
): Promise<WebAuthnChallengeDoc | null> {
  return (await challenges()).findOneAndDelete({
    type,
    expiresAt: { $gt: new Date() },
  }, { sort: { createdAt: -1 } });
}
