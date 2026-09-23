import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

// Node's built-in scrypt, not bcrypt/argon2 — this module only runs in the
// Node runtime (the login API route and the seed script), never in
// middleware (Edge runtime), so there's no reason to add a dependency when
// node:crypto already does this. Contrast with app/lib/auth/session.ts,
// which genuinely needs to run in both runtimes and so sticks to Web
// Crypto only.
const scrypt = promisify(scryptCallback);

const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, hashHex] = storedHash.split(':');
  if (!salt || !hashHex) return false;
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  const storedKey = Buffer.from(hashHex, 'hex');
  // Lengths must match before timingSafeEqual (it throws on a mismatch
  // instead of returning false) — a corrupt/truncated stored hash must
  // fail closed, not crash the login request.
  if (derivedKey.length !== storedKey.length) return false;
  return timingSafeEqual(derivedKey, storedKey);
}
