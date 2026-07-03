import SendMoneyPageShell from '@/app/components/SendMoneyPageShell';
import { getSendMoneyRoute } from '@/app/lib/sendMoneyRoutes';

export default function SendMoneyTopUpPage() {
  const route = getSendMoneyRoute('/sendmoney/topup');
  return <SendMoneyPageShell title={route.title} itemLabel={route.itemLabel} />;
}
