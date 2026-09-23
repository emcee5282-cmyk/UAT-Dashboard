import { NextResponse } from 'next/server';
import { getBusinessToday, manilaFields } from '@/app/lib/businessDate';
import { getDailyTxnWalletClosing } from '@/app/lib/db/read/dailyTxnWalletClosing';
import { upsertWalletClosingEntries } from '@/app/lib/services/dailyTxnEntryService';

// Report tab's "Wallet Breakdown Opening" (YesterdayClosingCard), one
// ledger (ssp1 or ssp2) at a time, "today" only. Self-contained — entered
// directly here, not derived from the Operations tab's per-brand ledgers
// (confirmed explicitly; different dimension, no existing mapping).

function todayStr(): string {
  const { year, month, day } = manilaFields(getBusinessToday());
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isValidLedgerId(v: unknown): v is 'ssp1' | 'ssp2' {
  return v === 'ssp1' || v === 'ssp2';
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ledgerId = url.searchParams.get('ledgerId');
  if (!isValidLedgerId(ledgerId)) {
    return NextResponse.json({ error: 'Expected ?ledgerId=ssp1|ssp2' }, { status: 400 });
  }

  const businessDate = todayStr();
  const allRows = await getDailyTxnWalletClosing(ledgerId, businessDate);
  const rows = allRows.map((r) => ({ wallet: r.wallet, amount: r.amount }));
  const entered = allRows.filter((r) => r.amount !== null);
  const lastUpdate = entered.length > 0 ? new Date(Math.max(...entered.map((r) => r.updatedAt.getTime()))).toISOString() : null;

  return NextResponse.json({ businessDate, rows, lastUpdate });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const ledgerId = body?.ledgerId;
  const rows = body?.rows;
  if (!isValidLedgerId(ledgerId) || !Array.isArray(rows)) {
    return NextResponse.json({ error: 'Expected { ledgerId: "ssp1"|"ssp2", rows: { wallet, amount }[] }' }, { status: 400 });
  }

  const businessDate = todayStr();
  await upsertWalletClosingEntries(
    rows.map((r: { wallet: string; amount: number | null }) => ({
      ledgerId,
      wallet: r.wallet,
      businessDate,
      amount: r.amount ?? null,
    }))
  );

  return NextResponse.json({ ok: true, businessDate });
}
