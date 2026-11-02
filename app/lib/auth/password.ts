import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { argon2id, argon2Verify } from 'hash-wasm';

// argon2id for every new hash (OWASP's first choice). Accounts created
// before this switch still hold the old Node-scrypt "salt:hex" format —
// verifyPassword() accepts both, and the login route re-hashes a legacy
// hash to argon2id on the next successful login (see needsRehash), so the
// old format drains away without forcing anyone to reset.
//
// hash-wasm is pure WebAssembly: the standalone build made on Windows runs
// unchanged on the Linux VPS (a native addon would ship the wrong binary).
// Hashes are standard PHC strings ($argon2id$v=19$m=…,t=…,p=…$salt$hash),
// so ones written earlier by @node-rs/argon2 still verify.
//
// Node runtime only (proxy.ts and route handlers both run on Node in Next 16).
const scrypt = promisify(scryptCallback);
const LEGACY_KEY_LENGTH = 64;

// OWASP's recommended argon2id minimum (m=19456 KiB, t=2, p=1) — the same
// parameters the previous library used by default.
const ARGON2_PARAMS = { memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32 } as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2id({ password, salt: randomBytes(16), ...ARGON2_PARAMS, outputType: 'encoded' });
}

export function needsRehash(storedHash: string): boolean {
  return !storedHash.startsWith('$argon2id$');
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;
  if (storedHash.startsWith('$argon2')) {
    try {
      return await argon2Verify({ password, hash: storedHash });
    } catch {
      return false;
    }
  }
  const [salt, hashHex] = storedHash.split(':');
  if (!salt || !hashHex) return false;
  const derivedKey = (await scrypt(password, salt, LEGACY_KEY_LENGTH)) as Buffer;
  const storedKey = Buffer.from(hashHex, 'hex');
  // Lengths must match before timingSafeEqual (it throws on a mismatch
  // instead of returning false) — a corrupt/truncated stored hash must
  // fail closed, not crash the login request.
  if (derivedKey.length !== storedKey.length) return false;
  return timingSafeEqual(derivedKey, storedKey);
}

// A real hash of a random string, computed once — verified against when
// the username doesn't exist, so a login for an unknown user takes the same
// time as a wrong password for a real one (no username enumeration by timing).
let dummyHashPromise: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHashPromise ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHashPromise);
}

export { validatePasswordRules } from './passwordRules';

// 16 chars from an unambiguous alphabet (no 0/O/1/l/I), always with at
// least one upper, lower and digit — ~93 bits of entropy.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
export function generateTempPassword(length = 16): string {
  const all = UPPER + LOWER + DIGITS;
  const chars = [UPPER[randomInt(UPPER.length)], LOWER[randomInt(LOWER.length)], DIGITS[randomInt(DIGITS.length)]];
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
