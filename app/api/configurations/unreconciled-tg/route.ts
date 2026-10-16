import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/app/lib/auth/requireAdmin';
import { getUnreconciledTgData, saveUnreconciledTgData, type UnreconciledTgSaveInput } from '@/app/lib/services/unreconciledTgService';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  try {
    const data = await getUnreconciledTgData();
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load Unreconciled TG settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  try {
    const body = (await request.json()) as Partial<UnreconciledTgSaveInput>;
    if (typeof body.token !== 'string' || !Array.isArray(body.rows)) {
      return NextResponse.json({ error: 'Malformed request body.' }, { status: 400 });
    }
    const input: UnreconciledTgSaveInput = {
      token: body.token,
      rows: body.rows.map((r) => ({
        groupName: String(r?.groupName ?? ''),
        tgId: String(r?.tgId ?? ''),
      })),
    };
    await saveUnreconciledTgData(input, session.username);
    const data = await getUnreconciledTgData();
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save Unreconciled TG settings';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
