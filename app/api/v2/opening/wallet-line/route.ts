import { NextResponse } from 'next/server';
import { updateOpeningWalletLine, deleteOpeningWalletLine, OpeningActionError } from '@/app/lib/services/openingActionsService';

// Edit/Delete for a single opening_wallet_lines row — the per-wallet
// Opening Balance breakdown a multi-wallet shop's file rows produce (e.g.
// "N-K1AG-T1-SANGE006-BK"). Deliberately separate from /api/v2/opening's
// own PATCH/DELETE (which key by agentCode): a wallet line has no
// agentCode of its own to match against, only its own row id.
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const lineId = body?.lineId;
    if (typeof lineId !== 'number') {
      return NextResponse.json({ error: 'lineId is required.' }, { status: 400 });
    }
    const updates: { openingBalance?: string; sdp?: string } = {};
    if (typeof body?.openingBalance === 'string') updates.openingBalance = body.openingBalance;
    if (typeof body?.sdp === 'string') updates.sdp = body.sdp;
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'openingBalance and/or sdp is required.' }, { status: 400 });
    }
    const result = await updateOpeningWalletLine(lineId, updates);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OpeningActionError) return NextResponse.json({ error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : 'Update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const lineId = body?.lineId;
    if (typeof lineId !== 'number') {
      return NextResponse.json({ error: 'lineId is required.' }, { status: 400 });
    }
    const result = await deleteOpeningWalletLine(lineId);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OpeningActionError) return NextResponse.json({ error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
