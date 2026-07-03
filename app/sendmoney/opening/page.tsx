import SendMoneyPageShell from '@/app/components/SendMoneyPageShell';
import { getSendMoneyRoute } from '@/app/lib/sendMoneyRoutes';

export default function SendMoneyOpeningPage() {
  const route = getSendMoneyRoute('/sendmoney/opening');
  return <SendMoneyPageShell title={route.title} itemLabel={route.itemLabel} />;
}
