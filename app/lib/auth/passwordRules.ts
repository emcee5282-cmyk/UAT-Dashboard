// Password policy — pure, so the change-password page can show and
// live-check the exact rules the server enforces (app/api/auth/change-password).

export const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 200;

export const PASSWORD_RULES: { label: string; test: (password: string) => boolean }[] = [
  { label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (p) => p.length >= PASSWORD_MIN_LENGTH },
  { label: 'At least one letter', test: (p) => /[A-Za-z]/.test(p) },
  { label: 'At least one number', test: (p) => /[0-9]/.test(p) },
];

// "Generate" on the change-password page: 12 random characters from
// crypto.getRandomValues, always with an uppercase letter, a lowercase
// letter, a number and a symbol (so it passes the rules above). Look-alike
// characters (0/O, 1/l/I) are left out so it's easy to read and type.
export const GENERATED_PASSWORD_LENGTH = 12;
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%&*?-_';

// Unbiased index in [0, n) via rejection sampling.
function randomIndex(n: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}

export function generatePassword(length = GENERATED_PASSWORD_LENGTH): string {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const chars = [UPPER, LOWER, DIGITS, SYMBOLS].map((set) => set[randomIndex(set.length)]);
  while (chars.length < length) chars.push(all[randomIndex(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// Returns an error message, or null when the password is acceptable.
export function validatePasswordRules(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return 'Password is too long.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Password must contain both letters and numbers.';
  return null;
}
