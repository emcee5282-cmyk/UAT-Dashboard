import { getDb } from '../app/lib/db/client';
import { buildFamilyLeaderMap, isPlaceholderLeaderName } from '../app/lib/services/importService';
import { extractRawWalletFamily } from '../app/lib/realShopName';

async function main() {
  const db = getDb();
  const map = await buildFamilyLeaderMap(db, 'sendmoney');
  console.log('family for N-B2PS2-ARCANE040-BK:', extractRawWalletFamily('N-B2PS2-ARCANE040-BK'));
  console.log('resolved leader:', map.get(extractRawWalletFamily('N-B2PS2-ARCANE040-BK')));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
