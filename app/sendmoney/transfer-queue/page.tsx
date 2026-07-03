import SendMoneyPageShell from '@/app/components/SendMoneyPageShell';
import { getSendMoneyRoute } from '@/app/lib/sendMoneyRoutes';

export default function SendMoneyTransferQueuePage() {
  const route = getSendMoneyRoute('/sendmoney/transfer-queue');
  return <SendMoneyPageShell title={route.title} itemLabel={route.itemLabel} />;
}
