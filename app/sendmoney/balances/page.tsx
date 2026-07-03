import SendMoneyPageShell from '@/app/components/SendMoneyPageShell';
import { getSendMoneyRoute } from '@/app/lib/sendMoneyRoutes';

export default function SendMoneyBalancesPage() {
  const route = getSendMoneyRoute('/sendmoney/balances');
  return <SendMoneyPageShell title={route.title} itemLabel={route.itemLabel} />;
}
