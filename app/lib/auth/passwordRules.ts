// Password policy — pure, so the change-password page can show and
// live-check the exact rules the server enforces (app/api/auth/change-password).

export const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 200;

export const PASSWORD_RULES: { label: string; test: (password: string) => boolean }[] = [
  { label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (p) => p.length >= PASSWORD_MIN_LENGTH },
  { label: 'At least one letter', test: (p) => /[A-Za-z]/.test(p) },
  { label: 'At least one number', test: (p) => /[0-9]/.test(p) },
];
// Checked server-side only (needs the stored hash) — listed for display.
export const PASSWORD_REUSE_RULE = 'Different from your temporary / current password';

// Returns an error message, or null when the password is acceptable.
export function validatePasswordRules(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return 'Password is too long.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Password must contain both letters and numbers.';
  return null;
}
