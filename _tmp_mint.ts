import { createSessionToken } from './lib/auth-crypto.ts';
process.stdout.write(createSessionToken());
