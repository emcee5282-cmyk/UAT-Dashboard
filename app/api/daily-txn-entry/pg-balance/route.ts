import { NextResponse } from 'next/server';
import { getBusinessToday, manilaFields } from '@/app/lib/businessDate';
import { getDailyTxnPgBalance, getLatestPgBalanceSnapshot } from '@/app/lib/db/read/dailyTxnPgBalance';
import { upsertPgBalanceEntries } from '@/app/lib/services/dailyTxnEntryService';

// Report tab's "PG Closing Balances" (PgClosingBalancesCard) — all 6 PG
// keys x brand in one table with one Save button, "today" only.
// Self-contained, same as wallet-closing above (not derived from Operations
// tab's ledgers).

const PG_KEYS = ['autopay', 'expay', 'ssp1', 'ssp2', 'essPg', 'hkpay', 'phbpay'] as const;

function todayStr(): string {
  const { year, month, day } = manilaFields(getBusinessToday());
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export async function GET() {
  const businessDate = todayStr();
  const allRows = await getDailyTxnPgBalance(businessDate);

  // Per-column carry-forward: a PG whose entire column is still blank today
  // (nothing entered yet since the nightly rollover) falls back to its own
  // most recent real snapshot instead of showing 0.00 for every brand — per
  // explicit follow-up, this card should keep displaying the last uploaded
  // figures rather than reading as "opening reset to zero" on a fresh
  // business day. A PG with ANY real entry today is left exactly as-is (the
  // user is actively working on it) — carry-forward never overwrites a real
  // today's-date row.
  const enteredPgKeys = new Set(allRows.filter((r) => r.amount !== null).map((r) => r.pgKey));
  const emptyPgKeys = PG_KEYS.filter((k) => !enteredPgKeys.has(k));
  const snapshots = await Promise.all(emptyPgKeys.map((pgKey) => getLatestPgBalanceSnapshot(pgKey, businessDate)));

  const rows = allRows
    .filter((r) => !emptyPgKeys.includes(r.pgKey as (typeof PG_KEYS)[number]))
    .map((r) => ({ pgKey: r.pgKey, brand: r.brand, amount: r.amount }));

  // Per-PG "Last Update" — NOT one global value shared across all 6 columns.
  // Save commits every cell in the grid at once (one shared Edit/Save for
  // the whole table), but upsertPgBalanceEntries now only bumps a row's own
  // updated_at when its amount actually changed — so a PG nobody touched
  // keeps showing its own prior timestamp instead of jumping to "just now"
  // alongside whichever PG was genuinely edited. Per explicit instruction.
  const lastUpdateByPg: Record<string, string | null> = Object.fromEntries(PG_KEYS.map((k) => [k, null]));
  // Only rows with a real (non-null) amount count towards "last update" —
  // blank placeholder rows created by the rollover job carry a fresh
  // updatedAt too, which would otherwise misleadingly read as "just updated"
  // for data nobody has actually entered yet.
  for (const r of allRows) {
    if (r.amount === null || emptyPgKeys.includes(r.pgKey as (typeof PG_KEYS)[number])) continue;
    const current = lastUpdateByPg[r.pgKey];
    if (!current || r.updatedAt.toISOString() > current) lastUpdateByPg[r.pgKey] = r.updatedAt.toISOString();
  }
  // Carried-forward columns use their own snapshot's updatedAt instead of
  // today's placeholder rows.
  emptyPgKeys.forEach((pgKey, i) => {
    const snap = snapshots[i];
    if (!snap) return;
    for (const [brand, amount] of Object.entries(snap.values)) rows.push({ pgKey, brand, amount });
    lastUpdateByPg[pgKey] = snap.updatedAt.toISOString();
  });

  return NextResponse.json({ businessDate, rows, lastUpdateByPg });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const rows = body?.rows;
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: 'Expected { rows: { pgKey, brand, amount }[] }' }, { status: 400 });
  }

  const businessDate = todayStr();
  await upsertPgBalanceEntries(
    rows.map((r: { pgKey: string; brand: string; amount: number | null }) => ({
      pgKey: r.pgKey,
      brand: r.brand,
      businessDate,
      amount: r.amount ?? null,
    }))
  );

  return NextResponse.json({ ok: true, businessDate });
}
