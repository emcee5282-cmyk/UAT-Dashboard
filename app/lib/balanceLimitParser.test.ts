// Run: npx tsx --test app/lib/balanceLimitParser.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSendMoneyLockedRows, mergeOldRows, stripOldTag, type BalanceLimitRow } from './balanceLimitParser';

let rowNo = 1;
function row(shopCode: string, rawStatus: string, totalDP: string, totalWD: string, extra: Partial<BalanceLimitRow> = {}): BalanceLimitRow {
  return {
    row: rowNo++, rawAccount: `0 - ${shopCode}`, shopCode, accountStatus: 'G', rawStatus, bank: 'NAGADC',
    group: 'G', balance: '100', totalDP, totalWD, login: 'Login', dpLimit: '0', ...extra,
  };
}

test('Locked old-prefix row folds DP/WD into the Active row, balance not carried', () => {
  const locked = row('N-B2PS3-SHEL042-NG', 'Locked', '1,000', '0', { balance: '3048.32' });
  const active = row('N-M1PS3-SHEL042-NG', 'Active', '50,000', '76,540', { group: 'SH- 24/7 Solo DP+WD' });
  const out = mergeSendMoneyLockedRows([locked, active]);
  assert.equal(out.length, 1);
  assert.equal(out[0].shopCode, 'N-M1PS3-SHEL042-NG');
  assert.equal(out[0].totalDP, '51000');
  assert.equal(out[0].totalWD, '76540');
  assert.equal(out[0].balance, '100');
  assert.equal(out[0].group, 'SH- 24/7 Solo DP+WD');
});

test('stray space in the prefix still matches', () => {
  const out = mergeSendMoneyLockedRows([row('N- M2PS1-BROOK058-NG', 'Locked', '5', '5'), row('N-M2PS1-BROOK058-NG', 'Active', '1', '1')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].totalDP, '6');
});

test('Disable / Reach Limit rows are not merged', () => {
  const rows = [row('N-B2PS3-X001-NG', 'Disable', '5', '5'), row('N-M1PS3-X001-NG', 'Active', '1', '1')];
  assert.deepEqual(mergeSendMoneyLockedRows(rows), rows);
});

test('no merge without exactly one Active row', () => {
  const none = [row('N-B2PS3-X002-NG', 'Locked', '5', '5'), row('N-M1PS3-X002-NG', 'Locked', '1', '1')];
  assert.deepEqual(mergeSendMoneyLockedRows(none), none);
  const two = [row('N-B2PS3-X003-NG', 'Locked', '5', '5'), row('N-M1PS3-X003-NG', 'Active', '1', '1'), row('N-K1PS3-X003-NG', 'Active', '1', '1')];
  assert.deepEqual(mergeSendMoneyLockedRows(two), two);
});

test('different wallet or different shop code is not merged', () => {
  const rows = [row('N-B2PS3-X004-BK', 'Locked', '5', '5', { bank: 'BKASHC' }), row('N-M1PS3-X004-NG', 'Active', '1', '1'), row('N-B2PS3-X005-NG', 'Locked', '5', '5')];
  assert.deepEqual(mergeSendMoneyLockedRows(rows), rows);
});

test('same exact name Locked + Active is left as-is', () => {
  const rows = [row('N-M1PS3-X006-NG', 'Locked', '5', '5'), row('N-M1PS3-X006-NG', 'Active', '1', '1')];
  assert.deepEqual(mergeSendMoneyLockedRows(rows), rows);
});

test('invalid number on the Locked row is not merged (validateRow still flags it)', () => {
  const rows = [row('N-B2PS3-X007-NG', 'Locked', 'abc', '5'), row('N-M1PS3-X007-NG', 'Active', '1', '1')];
  assert.deepEqual(mergeSendMoneyLockedRows(rows), rows);
});

// --- mergeOldRows ---
function oldRow(rawName: string, totalDP: string, totalWD: string, extra: Partial<BalanceLimitRow> = {}): BalanceLimitRow {
  return row('OLD', 'Locked', totalDP, totalWD, { rawAccount: `0 - ${rawName}`, balance: '999', ...extra });
}

test('stripOldTag handles -OLD, glued BKOLD, leading OLD-, and rejects non-OLD / GOLD names', () => {
  assert.equal(stripOldTag('0 - N-M1PS2-DREAM001A-NG-OLD'), '0 - N-M1PS2-DREAM001A-NG');
  assert.equal(stripOldTag('0 - D-M1AG-M1-JETT020-BKOLD'), '0 - D-M1AG-M1-JETT020-BK');
  assert.equal(stripOldTag('0 - OLD-D-M1AG-M1-JETT020-BK'), '0 - D-M1AG-M1-JETT020-BK');
  assert.equal(stripOldTag('0 - D-M1AG-M1-JETT020-BK'), null);
  assert.equal(stripOldTag('0 - D-M1AG-M1-GOLD001-BK-OLD'), null);
});

test('Send Money OLD row folds DP/WD into the Active same-shop/same-wallet row, balance not carried', () => {
  const active = row('N-M1PS2-DREAM001A-NG', 'Active', '1,000', '500');
  const locked = row('N-M1PS2-DREAM001A-NG', 'Locked', '10', '0');
  const old = oldRow('N-M1PS2-DREAM001A-NG-OLD', '2,000', '300');
  const out = mergeOldRows([locked, active, old], 'sendmoney');
  assert.equal(out.length, 2);
  const a = out.find((r) => r.rawStatus === 'Active')!;
  assert.equal(a.totalDP, '3000');
  assert.equal(a.totalWD, '800');
  assert.equal(a.balance, '100');
  assert.equal(out.find((r) => r.rawStatus === 'Locked')!.totalDP, '10');
});

test('Send Money OLD row under a different prefix still finds its shop', () => {
  const active = row('N-M1PS3-SHEL042-NG', 'Active', '100', '0');
  const out = mergeOldRows([active, oldRow('N-B2PS3-SHEL042-NG-OLD', '50', '20')], 'sendmoney');
  assert.equal(out.length, 1);
  assert.equal(out[0].totalDP, '150');
  assert.equal(out[0].totalWD, '20');
});

test('OLD row with no current account is kept as its own line under the real shop, balance 0', () => {
  const out = mergeOldRows([oldRow('N-M1PS2-DREAM009A-NG-OLD', '700', '0')], 'sendmoney');
  assert.equal(out.length, 1);
  assert.equal(out[0].shopCode, 'N-M1PS2-DREAM009A-NG');
  assert.equal(out[0].rawAccount, '0 - N-M1PS2-DREAM009A-NG');
  assert.equal(out[0].totalDP, '700');
  assert.equal(out[0].balance, '0');
});

test('OLD rows with zero DP/WD or bad amounts stay OLD (dropped later)', () => {
  const out = mergeOldRows([oldRow('N-M1PS2-DREAM001A-NG-OLD', '0', '0'), oldRow('N-M1PS2-DREAM002A-NG-OLD', 'abc', '0')], 'sendmoney');
  assert.ok(out.every((r) => r.shopCode === 'OLD'));
});

test('Cashout OLD row merges into the bare shop code on the same bank', () => {
  const active = row('SWEET001', 'Active', '206,510', '160,316', { bank: 'BKASH', rawAccount: '0 - U-M1AG-M4-SWEET001-BK' });
  const other = row('SWEET001', 'Active', '5', '5', { bank: 'NAGAD', rawAccount: '0 - U-M1AG-M4-SWEET001-NG' });
  const old = oldRow('U-M1AG-M4-SWEET001-BK-OLD', '1,000', '400', { bank: 'BKASH' });
  const out = mergeOldRows([active, other, old], 'cashout');
  assert.equal(out.length, 2);
  assert.equal(out.find((r) => r.bank === 'BKASH')!.totalDP, '207510');
  assert.equal(out.find((r) => r.bank === 'BKASH')!.totalWD, '160716');
  assert.equal(out.find((r) => r.bank === 'NAGAD')!.totalDP, '5');
});
