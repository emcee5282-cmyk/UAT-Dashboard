// Run: npx tsx --test app/lib/estimateTransactions.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEstimateTransactions, detectExportKind, parseUpdatedDate, previousDay } from './estimateTransactions';
import { extractRealShopName } from './realShopName';
import { CASHOUT_ESTIMATE_WALLET_TYPES } from './estimateUpload';

// Real export headers (trimmed to the columns that matter + the ones that
// tell the two files apart).
const DEP = ['Vendor', 'Deposit Type', 'Bank', 'From Account', 'To Account', 'Amount', 'Updated Time', 'Status'];
const PAY = ['Vendor', 'Type', 'SPID', 'Bank', 'From Account', 'To Account', 'Amount', 'Updated Time', 'Status'];
const extract = (raw: string | number) => extractRealShopName(raw);

const dep = (to: string, amount: string | number, updated: string, status = 'Successful', bank = 'BKASH') =>
  ['BO', 'eBanking', bank, '0170XXXX873', to, amount, updated, status];
const pay = (from: string, amount: string | number, updated: string, status = 'Successful', bank = 'BKASH') =>
  ['BO', 'Payout', '91841265', bank, from, 'BKASH - 01700000000 - pa', amount, updated, status];

test('detectExportKind tells Deposit from Payout and rejects the old Balance Limit file', () => {
  assert.equal(detectExportKind(DEP), 'dp');
  assert.equal(detectExportKind(PAY), 'wd');
  assert.equal(detectExportKind(['Bank', 'Group', 'Account', 'Balance', 'Total DP', 'Total WD']), null);
});

test('parseUpdatedDate reads DD/MM/YYYY text and Excel serials; previousDay crosses months', () => {
  assert.equal(parseUpdatedDate('16/11/2026 11:24:26'), '2026-11-16');
  assert.equal(parseUpdatedDate('5/1/2026'), '2026-01-05');
  assert.equal(parseUpdatedDate(46342.5), '2026-11-16');
  assert.equal(parseUpdatedDate('2026-11-16'), null);
  assert.equal(parseUpdatedDate('31/13/2026 00:00:00'), null);
  assert.equal(previousDay('2026-12-01'), '2026-11-30');
});

test('wrong DP/WD choice is rejected with a clear message', () => {
  assert.throws(() => parseEstimateTransactions(PAY, [], 'dp', extract), /Payout export, but Deposit \(DP\) was selected/);
  assert.throws(() => parseEstimateTransactions(DEP, [], 'wd', extract), /Deposit export, but Withdrawal \(WD\) was selected/);
});

test('DP sums per wallet (To Account) and per Updated Time day; non-Successful rows left out', () => {
  const rows = [
    dep('01712345678 - D-M1AG-L1-KJ008-BK', '1,100.00', '16/11/2026 11:24:26'),
    dep('01712345678 - D-M1AG-L1-KJ008-BK', 500, '16/11/2026 09:00:00'),
    dep('01712345678 - D-M1AG-L1-KJ008-NG', '200.50', '16/11/2026 10:00:00', 'Successful', 'NAGAD'),
    dep('01712345678 - D-M1AG-L1-KJ008-BK', '999', '15/11/2026 23:59:59'),
    dep('01712345678 - D-M1AG-L1-KJ008-BK', '777', '16/11/2026 10:00:00', 'Failed'),
  ];
  const r = parseEstimateTransactions(DEP, rows, 'dp', extract, CASHOUT_ESTIMATE_WALLET_TYPES);
  assert.equal(r.txnCount, 4);
  assert.equal(r.notSuccessfulCount, 1);
  assert.equal(r.detectedErrors, 0);
  assert.equal(r.shopCount, 1);
  assert.deepEqual(r.countByDate, { '2026-11-16': 3, '2026-11-15': 1 });
  const bk16 = r.sums.find((s) => s.account.endsWith('-BK') && s.date === '2026-11-16')!;
  assert.equal(bk16.amount, 1600);
  assert.equal(bk16.count, 2);
  assert.equal(r.sums.find((s) => s.account.endsWith('-NG'))!.amount, 200.5);
  assert.equal(r.sums.find((s) => s.date === '2026-11-15')!.amount, 999);
});

test('WD reads the shop from From Account, not To Account', () => {
  const r = parseEstimateTransactions(PAY, [pay('01712345678 - D-M1AG-L1-KJ035-BK', '2,600.00', '16/11/2026 11:26:53')], 'wd', extract);
  assert.equal(r.sums.length, 1);
  assert.equal(r.sums[0].account, '01712345678 - D-M1AG-L1-KJ035-BK');
  assert.equal(r.sums[0].amount, 2600);
});

test('bad rows are flagged and left out of the sums; skipped rows too', () => {
  const rows = [
    dep('01712345678 - D-M1AG-L1-KJ008-BK', 'abc', '16/11/2026 11:00:00'),
    dep('', '100', '16/11/2026 11:00:00'),
    dep('01712345678 - D-M1AG-L1-KJ008-BK', '100', 'yesterday'),
    dep('01712345678 - D-M1AG-L1-KJ008-BK', '100', '16/11/2026 11:00:00', 'Successful', 'PAYPAL'),
    dep('01712345678 - D-M1AG-L1-KJ008-BK', '300', '16/11/2026 11:00:00'),
    dep('01712345678 - D-M1AG-L1-KJ008-BK', '50', '16/11/2026 11:00:00'),
  ];
  const r = parseEstimateTransactions(DEP, rows, 'dp', extract, CASHOUT_ESTIMATE_WALLET_TYPES, new Set([7]));
  assert.equal(r.detectedErrors, 4);
  assert.deepEqual(r.rowErrors.map((e) => `${e.row}:${e.column}`), ['2:Amount', '3:To Account', '4:Updated Time', '5:Bank']);
  assert.equal(r.sums.length, 1);
  assert.equal(r.sums[0].amount, 300); // row 7 (the 50) was skipped
});

test('Cashout ignored wallet type (BKASHM) is left out, not flagged', () => {
  const r = parseEstimateTransactions(DEP, [dep('01712345678 - D-M1AG-L1-KJ008-BK', '100', '16/11/2026 11:00:00', 'Successful', 'BKASHM')], 'dp', extract, CASHOUT_ESTIMATE_WALLET_TYPES);
  assert.equal(r.detectedErrors, 0);
  assert.equal(r.txnCount, 0);
  assert.equal(r.sums.length, 0);
});

test('counted-day transactions the import would leave out are flagged; other days are not', () => {
  const shopCheck = { activityDate: '2026-11-16', shops: { KJ008: ['BKASH', 'NAGAD'], KJ035: null } };
  const rows = [
    dep('01712345678 - D-M1AG-L1-KJ008-BK', 100, '16/11/2026 10:00:00'),            // 2: on Opening line — ok
    dep('01712345678 - D-M1AG-L1-KJ035-RK', 100, '16/11/2026 10:00:00', 'Successful', 'ROCKET'), // 3: shop has no lines — ok
    dep('01712345678 - D-M1AG-L1-KJ008-BK-OLD', 50, '16/11/2026 10:00:00'),         // 4: OLD resolves to KJ008 — ok
    dep('01712345678 - D-M1AG-L1-KJ008-RK', 100, '16/11/2026 10:00:00', 'Successful', 'ROCKET'), // 5: RK not on KJ008's lines
    dep('01712345678 - D-M1AG-L1-ZZ999-BK', 100, '16/11/2026 10:00:00'),            // 6: unknown shop
    dep('01712345678 - OLD', 100, '16/11/2026 10:00:00'),                            // 7: OLD, unresolvable
    dep('00000000001 - MANUAL-BK', 100, '16/11/2026 10:00:00'),                      // 8: MANUAL
    dep('01712345678 - D-M1AG-L1-ZZ999-BK', 100, '15/11/2026 10:00:00'),            // 9: unknown shop, other day — not flagged
  ];
  const r = parseEstimateTransactions(DEP, rows, 'dp', extract, CASHOUT_ESTIMATE_WALLET_TYPES, new Set(), shopCheck);
  assert.deepEqual(r.rowErrors.map((e) => e.row), [5, 6, 7, 8]);
  assert.match(r.rowErrors[0].message, /-RK isn't one of KJ008's Opening wallets \(BK\/NG\)/);
  assert.match(r.rowErrors[1].message, /Shop \S*ZZ999\S* not found/);
  assert.match(r.rowErrors[2].message, /OLD account/);
  assert.match(r.rowErrors[3].message, /MANUAL/);
  assert.ok(r.rowErrors.every((e) => e.column === 'To Account'));
  // Flagged rows never reach the sums.
  const day = r.sums.filter((s) => s.date === '2026-11-16');
  assert.equal(day.reduce((s, w) => s + w.amount, 0), 250);
});

test('without a shop list nothing extra is flagged (old behaviour)', () => {
  const r = parseEstimateTransactions(DEP, [dep('01712345678 - D-M1AG-L1-ZZ999-BK', 100, '16/11/2026 10:00:00')], 'dp', extract);
  assert.equal(r.rowErrors.length, 0);
});
