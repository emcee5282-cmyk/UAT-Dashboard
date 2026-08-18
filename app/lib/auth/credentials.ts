// Temporary local-development credential check — the ONLY piece of the auth
// flow meant to be swapped out once real user/role storage (a DB or a
// Users sheet, per the roles/permissions plan) replaces it. Nothing else
// (session.ts, middleware.ts, the login route) needs to change when that
// happens — they only care about "is this username/password valid," not
// where the answer came from.
export const DEV_USERNAME = 'admin';
export const DEV_PASSWORD = 'admin123';

export function verifyCredentials(username: string, password: string): boolean {
  return username === DEV_USERNAME && password === DEV_PASSWORD;
}
