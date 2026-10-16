import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/app/lib/auth/requireAdmin';
import { getDiscrepancyTgData, getDiscrepancyTgLeaderOptions, saveDiscrepancyTgData, type DiscrepancyTgSaveInput } from '@/app/lib/services/discrepancyTgService';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  try {
    const [data, leaders] = await Promise.all([getDiscrepancyTgData(), getDiscrepancyTgLeaderOptions()]);
    return NextResponse.json({ ...data, leaders }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load Discrepancy TG settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  try {
    const body = (await request.json()) as Partial<DiscrepancyTgSaveInput>;
    if (typeof body.token !== 'string' || !Array.isArray(body.rows) || typeof body.cashoutThreshold !== 'number' || typeof body.sendmoneyThreshold !== 'number') {
      return NextResponse.json({ error: 'Malformed request body.' }, { status: 400 });
    }
    const input: DiscrepancyTgSaveInput = {
      token: body.token,
      cashoutThreshold: body.cashoutThreshold,
      sendmoneyThreshold: body.sendmoneyThreshold,
      rows: body.rows.map((r) => ({
        groupName: String(r?.groupName ?? ''),
        tgIdCashout: r?.tgIdCashout == null ? null : String(r.tgIdCashout),
        tgIdSendmoney: r?.tgIdSendmoney == null ? null : String(r.tgIdSendmoney),
      })),
    };
    await saveDiscrepancyTgData(input, session.username);
    const data = await getDiscrepancyTgData();
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save Discrepancy TG settings';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
