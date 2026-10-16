// Plain-assertion checks for Send to TG v2's buildSendPlan (threshold-based
// photos + always-all-shops PDF, album/message counting, timestamps) — no
// I/O, matches this project's existing scripts/_check-*.ts /
// scripts/_verify-*.ts convention (no test runner is configured here).
// Run with: npx tsx scripts/_verify-discrepancy-tg-send-plan.ts
import { buildSendPlan, type DiscrepancyTgRowLike } from '../app/lib/discrepancyTgSendPlan';
import type { DiscrepancyLeaderGroup, DiscrepancyShopEntry } from '../app/lib/discrepancySummaryAggregate';
import { formatBangladeshTimestamp, formatBangladeshCaptionTimestamp } from '../app/lib/discrepancyTgImageFormat';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// Agent Withdrawal descending, matching how the real aggregate hands
// shops to buildSendPlan — the first `aboveCount` entries land at/above
// `threshold`, the rest below it.
function makeShops(line: 'cashout' | 'sendmoney', total: number, aboveCount: number, threshold: number): DiscrepancyShopEntry[] {
  return Array.from({ length: total }, (_, i) => {
    const agentWithdrawal = i < aboveCount ? threshold + (aboveCount - i) : threshold - 1 - (i - aboveCount);
    return { line, shopName: `SHOP${i + 1}`, sdp: 100000, companyBalance: agentWithdrawal + 1000, balanceInside: 0, agentWithdrawal };
  });
}

function makeLeader(leader: string, cashout: DiscrepancyShopEntry[], sendmoney: DiscrepancyShopEntry[]): DiscrepancyLeaderGroup {
  const shops = [...cashout, ...sendmoney];
  return { leader, hasIncludedShops: shops.length > 0, shops, sdp: 0, companyBalance: 0, balanceInside: 0, agentWithdrawal: 0 };
}

const tgRow: DiscrepancyTgRowLike = { groupName: 'MR LEE', tgIdCashout: '-100111', tgIdSendmoney: '-100222' };
const timestamps = { cashout: new Date('2026-10-14T09:16:00.000Z'), sendmoney: null };
const thresholds = { cashout: 20000, sendmoney: 10000 };

// --- 0 positive shops -> nothing ---
{
  const plan = buildSendPlan([makeLeader('MR LEE', [], [])], [tgRow], timestamps, thresholds);
  check('0 shops -> leader absent entirely (no included shops)', plan.leaders.length, 0);
}

// --- shops > 0, 0 above threshold -> PDF only, all shops, no photos ---
{
  const cashout = makeShops('cashout', 22, 0, 20000);
  const plan = buildSendPlan([makeLeader('MR LEE', cashout, [])], [tgRow], timestamps, thresholds);
  const job = plan.jobs.find((j) => j.line === 'cashout')!;
  check('22 shops, 0 above -> kind pdfOnly', plan.leaders[0].cashout.kind, 'pdfOnly');
  check('22 shops, 0 above -> no photo pages', job.photoPages.length, 0);
  check('22 shops, 0 above -> pdf has all 22 shops, 1 page', job.pdfPages.length, 1);
  check('22 shops, 0 above -> pdf page has 22 rows', job.pdfPages[0].rows.length, 22);
  check('22 shops, 0 above -> messagesCount 1', job.messagesCount, 1);
}

// --- 30 at/above -> exactly 1 photo, no PDF ---
{
  const cashout = makeShops('cashout', 30, 30, 20000);
  const plan = buildSendPlan([makeLeader('MR LEE', cashout, [])], [tgRow], timestamps, thresholds);
  const job = plan.jobs.find((j) => j.line === 'cashout')!;
  check('30 above -> kind photosOnly', plan.leaders[0].cashout.kind, 'photosOnly');
  check('30 above -> 1 photo page', job.photoPages.length, 1);
  check('30 above -> no pdf', job.pdfPages.length, 0);
  check('30 above -> messagesCount 1', job.messagesCount, 1);
}

// --- 31 above out of 130 total -> 2 photos (30+1) + PDF (130 shops, 5 pages) ---
{
  const cashout = makeShops('cashout', 130, 31, 20000);
  const plan = buildSendPlan([makeLeader('MR LEE', cashout, [])], [tgRow], timestamps, thresholds);
  const job = plan.jobs.find((j) => j.line === 'cashout')!;
  check('31 above/130 total -> kind photosAndPdf', plan.leaders[0].cashout.kind, 'photosAndPdf');
  check('31 above/130 total -> 2 photo pages (30+1)', job.photoPages.length, 2);
  check('31 above/130 total -> pdf has 5 pages (130 shops)', job.pdfPages.length, 5);
  check('31 above/130 total -> pdf page 1 has 30 rows, page 5 has 10', [job.pdfPages[0].rows.length, job.pdfPages[4].rows.length], [30, 10]);
  check('31 above/130 total -> 1 album (<=10 photos), messagesCount 2', [job.albumsCount, job.messagesCount], [1, 2]);
}

// --- a shop at exactly the threshold is included; threshold-1 is not ---
{
  const shops: DiscrepancyShopEntry[] = [
    { line: 'cashout', shopName: 'AT_THRESHOLD', sdp: 0, companyBalance: 0, balanceInside: 0, agentWithdrawal: 20000 },
    { line: 'cashout', shopName: 'BELOW_THRESHOLD', sdp: 0, companyBalance: 0, balanceInside: 0, agentWithdrawal: 19999 },
  ];
  const plan = buildSendPlan([makeLeader('MR LEE', shops, [])], [tgRow], timestamps, thresholds);
  const job = plan.jobs.find((j) => j.line === 'cashout')!;
  check('exactly-20,000 shop included in photos, 19,999 excluded (>=)', job.photoPages[0].rows.map((r) => r.row.shopName), ['AT_THRESHOLD']);
  check('1 shop above (the threshold one) -> photosOnly, no pdf', plan.leaders[0].cashout.kind, 'photosOnly');
}

// --- Send Money threshold (10,000) applied separately from Cashout (20,000) ---
{
  const sendmoney: DiscrepancyShopEntry[] = [
    { line: 'sendmoney', shopName: 'SM1', sdp: 0, companyBalance: 0, balanceInside: 0, agentWithdrawal: 10000 },
    { line: 'sendmoney', shopName: 'SM2', sdp: 0, companyBalance: 0, balanceInside: 0, agentWithdrawal: 19000 }, // would fail the Cashout threshold, passes Send Money's
  ];
  const plan = buildSendPlan([makeLeader('MR LEE', [], sendmoney)], [tgRow], timestamps, thresholds);
  const job = plan.jobs.find((j) => j.line === 'sendmoney')!;
  check('Send Money threshold (10,000) includes both shops', job.photoPages[0].rows.length, 2);
  check('Send Money line uses its own threshold, not Cashout’s', job.thresholdUsed, 10000);
}

// --- 305 above -> 11 photos -> 2 albums (10 + 1) ---
{
  const cashout = makeShops('cashout', 305, 305, 20000);
  const plan = buildSendPlan([makeLeader('MR LEE', cashout, [])], [tgRow], timestamps, thresholds);
  const job = plan.jobs.find((j) => j.line === 'cashout')!;
  check('305 above -> 11 photo pages', job.photoPages.length, 11);
  check('305 above -> 2 albums (10+1)', job.albumsCount, 2);
  // Above >= 31 always also sends the Full Shop List PDF (all shops, even
  // when every shop happens to clear the threshold) — not just the photos.
  check('305 above -> pdf also sent (all 305 shops, 11 pages)', job.pdfPages.length, 11);
  check('305 above -> messagesCount 3 (2 albums + 1 pdf)', job.messagesCount, 3);
}

// --- one group for both lines -> job order Cashout before Send Money ---
{
  const cashout = makeShops('cashout', 10, 10, 20000);
  const sendmoney = makeShops('sendmoney', 10, 10, 10000);
  const oneGroupRow: DiscrepancyTgRowLike = { groupName: 'MR LEE', tgIdCashout: '-100111', tgIdSendmoney: null };
  const plan = buildSendPlan([makeLeader('MR LEE', cashout, sendmoney)], [oneGroupRow], timestamps, thresholds);
  check('both lines route to the same (only) id', plan.jobs.map((j) => j.chatId), ['-100111', '-100111']);
  check('job order: cashout before sendmoney', plan.jobs.map((j) => j.line), ['cashout', 'sendmoney']);
  check('sendmoney falls back -> routedTo other', plan.leaders[0].sendmoney.routedTo, 'other');
}

// --- header total/shop count reflect ALL shops, not just above-threshold ---
{
  const cashout = makeShops('cashout', 50, 10, 20000); // only 10 above threshold
  const plan = buildSendPlan([makeLeader('MR LEE', cashout, [])], [tgRow], timestamps, thresholds);
  const job = plan.jobs.find((j) => j.line === 'cashout')!;
  const expectedTotal = cashout.reduce((sum, s) => sum + s.agentWithdrawal, 0);
  check('headerShopCount counts all 50 shops, not just the 10 above', job.headerShopCount, 50);
  check('headerTotal sums all 50 shops’ Agent Withdrawal, not just the 10 above', job.headerTotal, expectedTotal);
}

// --- totalMessages sums messagesCount across jobs, not just job count ---
{
  const leaderA = makeLeader('MR LEE', makeShops('cashout', 130, 31, 20000), []); // 2 photos + pdf = 2 messages
  const leaderB = makeLeader('SHAKIL', makeShops('cashout', 30, 30, 20000), []); // 1 photo = 1 message
  const rowB: DiscrepancyTgRowLike = { groupName: 'SHAKIL', tgIdCashout: '-200222', tgIdSendmoney: null };
  const plan = buildSendPlan([leaderA, leaderB], [tgRow, rowB], timestamps, thresholds);
  check('totalMessages = 2 (MR LEE) + 1 (SHAKIL) = 3, not 2 jobs', plan.totalMessages, 3);
}

// --- unconfigured leader never appears, not even as "skipped" ---
{
  const plan = buildSendPlan(
    [makeLeader('MR LEE', makeShops('cashout', 10, 10, 20000), []), makeLeader('UNCONFIGURED', makeShops('cashout', 10, 10, 20000), [])],
    [tgRow],
    timestamps,
    thresholds
  );
  check('unconfigured leader absent from leaders', plan.leaders.some((l) => l.leader === 'UNCONFIGURED'), false);
  check('unconfigured leader has no jobs', plan.jobs.some((j) => j.leader === 'UNCONFIGURED'), false);
}

// --- a configured row with BOTH ids blank is treated as no row at all ---
{
  const blankRow: DiscrepancyTgRowLike = { groupName: 'BLANK ROW', tgIdCashout: null, tgIdSendmoney: null };
  const plan = buildSendPlan(
    [makeLeader('MR LEE', makeShops('cashout', 10, 10, 20000), []), makeLeader('BLANK ROW', makeShops('cashout', 10, 10, 20000), [])],
    [tgRow, blankRow],
    timestamps,
    thresholds
  );
  check('leader with a blank-id row is absent from leaders', plan.leaders.some((l) => l.leader === 'BLANK ROW'), false);
  check('the properly configured leader still appears', plan.leaders.some((l) => l.leader === 'MR LEE'), true);
}

// --- GMT+8 -> GMT+6 conversion, both remaining timestamp formats (the PDF
// file name no longer carries a timestamp at all, per the "too long"
// amendment — see buildPdfFilename's own comment) ---
{
  // 5:16 PM in Asia/Manila (GMT+8) on 14 Oct 2026 = 09:16 UTC.
  const fivePmManila = new Date('2026-10-14T09:16:00.000Z');
  check('image header: 5:16 PM GMT+8 -> 3:16 PM GMT+6', formatBangladeshTimestamp(fivePmManila), '14 Oct 2026 · 3:16 PM GMT+6');
  check('caption: 5:16 PM GMT+8 -> Oct 14 | 03:16 PM GMT+6', formatBangladeshCaptionTimestamp(fivePmManila), 'Oct 14 | 03:16 PM GMT+6');

  // 1:30 AM Manila on 15 Oct 2026 = 17:30 UTC on 14 Oct -> 11:30 PM Dhaka on 14 Oct (crosses midnight backward).
  const oneThirtyAmManila = new Date('2026-10-14T17:30:00.000Z');
  check('image header crosses midnight: 1:30 AM GMT+8 -> 11:30 PM GMT+6 previous day', formatBangladeshTimestamp(oneThirtyAmManila), '14 Oct 2026 · 11:30 PM GMT+6');
  check('caption crosses midnight', formatBangladeshCaptionTimestamp(oneThirtyAmManila), 'Oct 14 | 11:30 PM GMT+6');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
