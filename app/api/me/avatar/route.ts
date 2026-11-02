import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/client';
import { users } from '@/app/lib/db/schema';
import { getRequestSession } from '@/app/lib/auth/guard';

// The signed-in user's own profile photo. Open to every role (it only ever
// touches session.userId — there's no user id in the request), listed in
// SELF_API_PATHS so the proxy skips the page-permission table for it.
// The client crops to 640x640 WebP 0.9 (JPEG 0.92 fallback) first — that's
// typically 30–150KB; this just checks the result is an image data URL with
// generous headroom. null clears it (back to initials).
const MAX_AVATAR_BYTES = 1024 * 1024;
const DATA_URL = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/;

export async function PATCH(request: NextRequest) {
  const session = await getRequestSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.mustChangePassword) return NextResponse.json({ error: 'Password change required' }, { status: 403 });

  let body: { avatar?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const avatar = body.avatar;
  if (avatar !== null) {
    if (typeof avatar !== 'string' || !DATA_URL.test(avatar)) {
      return NextResponse.json({ error: 'Photo must be a PNG, JPG or WebP image.' }, { status: 400 });
    }
    // Decoded size from the base64 length (no need to actually decode).
    const base64 = avatar.slice(avatar.indexOf(',') + 1);
    const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (bytes > MAX_AVATAR_BYTES) {
      return NextResponse.json({ error: 'Photo is too large after resizing (max 1MB).' }, { status: 400 });
    }
  }

  await getDb().update(users).set({ avatar, updatedAt: new Date() }).where(eq(users.id, session.userId));
  return NextResponse.json({ ok: true, avatar }, { headers: { 'Cache-Control': 'no-store' } });
}
