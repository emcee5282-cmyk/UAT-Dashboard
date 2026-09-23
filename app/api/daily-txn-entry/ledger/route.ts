import { NextResponse } from 'next/server';
import { getBusinessToday, manilaFields } from '@/app/lib/businessDate';
import { getDailyTxnLedgerEntries } from '@/app/lib/db/read/dailyTxnLedger';
import { getLatestPgBalanceSnapshot } from '@/app/lib/db/read/dailyTxnPgBalance';
import { upsertLedgerEntries } from '@/app/lib/services/dailyTxnEntryService';

// Operations tab's LedgerCard — one ledger's rows (per brand/rowKey) for
// "today" only. Session-gated by middleware.ts like the rest of the app; no
// extra auth here. businessDate is always computed server-side via
// getBusinessToday() (Manila, 2 AM reset), never trusted from the client.

function todayStr(): string {
  const { year, month, day } = manilaFields(getBusinessToday());
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Report tab's PG Closing Balances card is the PRIMARY source for
// "Opening Balance" (per explicit instruction) — dailyTxnLedgerEntry's own
// internal carry-forward value is kept only as a backup/recording copy for
// when Report tab has nothing yet. Maps this ledger's id to the matching
// PG key Report tab uses (the two tabs otherwise use different strings for
// the same gateway — 'ess'/'essPg', 'atp'/'autopay' — everything else matches).
const LEDGER_TO_PG_KEY: Record<string, string> = {
  ssp1: 'ssp1',
  ssp2: 'ssp2',
  ess: 'essPg',
  atp: 'autopay',
  expay: 'expay',
  hkpay: 'hkpay',
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ledgerId = url.searchParams.get('ledgerId');
  if (!ledgerId) {
    return NextResponse.json({ error: 'Missing ?ledgerId=' }, { status: 400 });
  }

  const businessDate = todayStr();
  const allRows = await getDailyTxnLedgerEntries(businessDate);
  const forLedger = allRows.filter((r) => r.ledgerId === ledgerId);
  const rows = forLedger.map((r) => ({ brand: r.brand, rowKey: r.rowKey, amount: r.amount }));

  const pgKey = LEDGER_TO_PG_KEY[ledgerId];
  const pgSnapshot = pgKey ? await getLatestPgBalanceSnapshot(pgKey, businessDate) : null;
  if (pgSnapshot) {
    // Overlay Report tab's values onto the 'opening' row, brand by brand —
    // a brand Report tab hasn't covered yet falls through to whatever
    // dailyTxnLedgerEntry already has for it (the backup copy), untouched.
    for (const [brand, amount] of Object.entries(pgSnapshot.values)) {
      const existing = rows.find((r) => r.rowKey === 'opening' && r.brand === brand);
      if (existing) existing.amount = amount;
      else rows.push({ brand, rowKey: 'opening', amount });
    }
  }

  // Most recent write across this ledger's rows, for the "Last update"
  // display — the client formats it via its own formatLastUpdate(), same as
  // every other timestamp on this page, so formatting stays in one place.
  const lastUpdate = forLedger.length > 0 ? new Date(Math.max(...forLedger.map((r) => r.updatedAt.getTime()))).toISOString() : null;

  return NextResponse.json({
    businessDate,
    rows,
    lastUpdate,
    // The business date Report tab's PG Closing Balance was last real for
    // this PG (null if it's never been recorded at all) — the client uses
    // this to tell the user how far back they need to catch up on
    // Deposit/Withdrawal entries, instead of a static "today only" note.
    pgBalanceAsOfDate: pgSnapshot?.businessDate ?? null,
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const ledgerId = body?.ledgerId;
  const rows = body?.rows;
  if (typeof ledgerId !== 'string' || !Array.isArray(rows)) {
    return NextResponse.json({ error: 'Expected { ledgerId: string, rows: { brand, rowKey, amount }[] }' }, { status: 400 });
  }

  const businessDate = todayStr();
  await upsertLedgerEntries(
    rows.map((r: { brand: string; rowKey: string; amount: number }) => ({
      ledgerId,
      brand: r.brand,
      rowKey: r.rowKey,
      businessDate,
      amount: r.amount,
    }))
  );

  return NextResponse.json({ ok: true, businessDate });
}
