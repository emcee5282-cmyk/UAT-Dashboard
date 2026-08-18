// Signed session cookie — HMAC-SHA256 via the Web Crypto API only (no
// node:crypto), so this one module works unchanged in both the Node
// runtime (the login API route) and the Edge runtime (middleware.ts).
// Swapping the credential source later (see credentials.ts) never touches
// this file — it only cares about "is there a validly signed, unexpired
// session," not how the username was verified.
export const SESSION_COOKIE_NAME = 'dashboard_session';

const REMEMBER_ME_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
// Non-"remember me" sessions still get an expiry ceiling baked into the
// payload (not just relying on the cookie being a browser-session cookie),
// in case the browser is configured to restore sessions on restart.
const DEFAULT_SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set');
  return secret;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export type SessionPayload = { username: string; exp: number };

export async function createSessionToken(
  username: string,
  persistent: boolean
): Promise<{ token: string; maxAge: number | undefined }> {
  const exp = Date.now() + (persistent ? REMEMBER_ME_MAX_AGE_SECONDS * 1000 : DEFAULT_SESSION_MS);
  const payload: SessionPayload = { username, exp };
  const encoder = new TextEncoder();
  const payloadPart = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(), encoder.encode(payloadPart));
  const signaturePart = base64UrlEncode(new Uint8Array(signature));
  return { token: `${payloadPart}.${signaturePart}`, maxAge: persistent ? REMEMBER_ME_MAX_AGE_SECONDS : undefined };
}

export async function verifySessionToken(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null;
  const [payloadPart, signaturePart] = token.split('.');
  if (!payloadPart || !signaturePart) return null;

  try {
    const encoder = new TextEncoder();
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(),
      base64UrlDecode(signaturePart),
      encoder.encode(payloadPart)
    );
    if (!valid) return null;

    const payload: SessionPayload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
