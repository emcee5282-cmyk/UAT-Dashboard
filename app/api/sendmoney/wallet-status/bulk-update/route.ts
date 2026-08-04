import { NextResponse } from 'next/server';
import { updateSendMoneyWalletStatusBulk, type Priority, type WalletStatusBulkUpdate } from '@/app/lib/walletStatus';

const VALID_PRIORITIES: Priority[] = ['Low', 'Normal', 'High'];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const rawUpdates = Array.isArray(body?.updates) ? body.updates : [];

    const updates: WalletStatusBulkUpdate[] = rawUpdates
      .map((u: unknown) => {
        const entry = u as { shopName?: unknown; priority?: unknown; remark?: unknown };
        const shopName = String(entry?.shopName ?? '').trim();
        const priorityRaw = entry?.priority !== undefined ? String(entry.priority).trim() : undefined;
        const priority = priorityRaw && VALID_PRIORITIES.includes(priorityRaw as Priority) ? (priorityRaw as Priority) : undefined;
        // Remark is legitimately allowed to be an empty string (clearing a
        // remark in bulk) — only `undefined` means "not part of this edit".
        const remark = typeof entry?.remark === 'string' ? entry.remark : undefined;
        return { shopName, priority, remark };
      })
      .filter((u: WalletStatusBulkUpdate) => u.shopName && (u.priority !== undefined || u.remark !== undefined));

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No valid updates provided.' }, { status: 400 });
    }

    const result = await updateSendMoneyWalletStatusBulk(updates);
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error applying bulk update';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
