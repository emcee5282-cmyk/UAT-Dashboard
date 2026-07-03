import SendMoneyPageShell from '@/app/components/SendMoneyPageShell';
import { getSendMoneyRoute } from '@/app/lib/sendMoneyRoutes';

export default function SendMoneySettlementPage() {
  const route = getSendMoneyRoute('/sendmoney/settlement');
  return <SendMoneyPageShell title={route.title} itemLabel={route.itemLabel} />;
}
