import { getLatestDailyTxnWalletClosing } from '../app/lib/db/read/dailyTxnWalletClosing';
import { getBusinessToday, manilaFields } from '../app/lib/businessDate';

function todayStr(): string {
  const { year, month, day } = manilaFields(getBusinessToday());
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function main() {
  const today = todayStr();
  console.log('today:', today);
  const rows = await getLatestDailyTxnWalletClosing('ssp2', today);
  console.log('Send Money (ssp2) latest wallet closing rows:', rows);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
