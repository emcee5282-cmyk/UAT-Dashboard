// Run: npx tsx --test app/lib/estimatedOpeningOld.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateByShop, aggregateByShopWithLines } from './estimatedOpening';
import { extractRealShopName, extractSendMoneyShopName } from './realShopName';

const header = ['Account', 'Bank', 'Total DP', 'Total WD'];

test('Estimated upload: an OLD account counts toward its real shop (CLAW006 case)', () => {
  const rows = [
    ['U-M1AG-K4-CLAW006-BK', 'BKASH', 1000, 400],
    ['U-M1AG-K4-CLAW006-BK-OLD', 'BKASH', 300, 5958],
  ];
  const shops = aggregateByShop(header, rows, extractRealShopName);
  assert.equal(shops.length, 1);
  assert.equal(shops[0].totalDP, 1300);
  assert.equal(shops[0].totalWD, 6358);

  // Per-wallet lines: the OLD row lands on the same "-BK" line.
  const lines = aggregateByShopWithLines(header, rows, extractRealShopName);
  assert.deepEqual(lines.map((l) => [l.shopName, l.rawAccount, l.totalDP, l.totalWD]), [
    [shops[0].shopName, 'U-M1AG-K4-CLAW006-BK', 1300, 6358],
  ]);
});

test('Estimated upload: OLD with no current row still counts; unresolvable OLD / MANUAL skipped', () => {
  const rows = [
    ['0 - N-M1PS2-DREAM009A-NG-OLD', 'NAGADC', 700, 0],
    ['0 - N-M1PS2-GOLD001-NG-OLD', 'NAGADC', 50, 0],
    ['MANUAL ADJ', 'NAGADC', 10, 0],
  ];
  const shops = aggregateByShop(header, rows, extractSendMoneyShopName);
  assert.deepEqual(shops.map((s) => [s.totalDP, s.totalWD]), [[700, 0]]);
});
