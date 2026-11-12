// Run: npx tsx --test app/lib/balanceLimitParser.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSendMoneyLockedRows, type BalanceLimitRow } from './balanceLimitParser';

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
