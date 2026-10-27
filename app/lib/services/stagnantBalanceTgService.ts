// Daily 2AM (Manila) Telegram send of the Stagnant Balances Excel export —
// triggered by a VPS cron job hitting app/api/cron/stagnant-balance-tg.
// 2AM is the business-day rollover (businessDate.ts's RESET_HOUR), so the
// file reports the business day that JUST ENDED: its Settlement column and
// Recovered (month-to-date through that day). Company Balance/Balance
// Inside/SDP/streak are the live figures at send time, i.e. that day's
// closing state.
//
// Bot token + chat id come from env (STAGNANT_TG_BOT_TOKEN,
// STAGNANT_TG_CHAT_ID) — never committed.
import { getStagnantBalanceRows } from './stagnantBalanceService';
import { buildAllStagnantViews, type StagnantAllViews } from '../stagnantBalanceAggregate';
import { buildStagnantBalanceWorkbook } from '../stagnantBalanceExport';
import { sendDocument } from '../server/discrepancyTgTelegramClient';
import { getBusinessToday, manilaFields } from '../businessDate';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function previousBusinessDate(): string {
  const { year, month, day } = manilaFields(getBusinessToday());
  return new Date(Date.UTC(year, month, day - 1)).toISOString().slice(0, 10);
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function buildStagnantTgCaption(views: StagnantAllViews, asOfDate: string): string {
  const line = (label: string, v: StagnantAllViews['cashout']) =>
    `${label}: ${fmt(v.buckets.total)} (${v.totals.shopCount} shops) · Settlement ${fmt(v.totals.settlementToday)} · Recovered ${fmt(v.buckets.recovered)}`;
  return [
    `📊 Stagnant Balances — ${formatDate(asOfDate)}`,
    '',
    line('Cashout', views.cashout),
    line('Send Money', views.sendmoney),
    line('Group Total', views.group),
    '',
    'Remarks: Company Balance of shops with no withdrawal for 3+ days. Settlement = settled on this date only. Recovered = settlement this month since each shop was posted on Stagnant Balances.',
  ].join('\n');
}

export type StagnantTgSendResult = { ok: true; asOfDate: string } | { ok: false; asOfDate: string; error: string };

export async function sendStagnantBalanceTg(options?: { asOfDate?: string }): Promise<StagnantTgSendResult> {
  const asOfDate = options?.asOfDate ?? previousBusinessDate();
  const token = process.env.STAGNANT_TG_BOT_TOKEN;
  const chatId = process.env.STAGNANT_TG_CHAT_ID;
  if (!token || !chatId) {
    return { ok: false, asOfDate, error: 'STAGNANT_TG_BOT_TOKEN / STAGNANT_TG_CHAT_ID not configured on the server' };
  }

  // force: always the freshest balances, never balanceService's cache.
  const { rows, recovered } = await getStagnantBalanceRows({ force: true, asOfDate });
  const views = buildAllStagnantViews(rows, recovered);
  const workbook = await buildStagnantBalanceWorkbook(views);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const result = await sendDocument(token, chatId, buffer, `Stagnant_Balances_${asOfDate}.xlsx`, buildStagnantTgCaption(views, asOfDate), XLSX_MIME);
  return result.ok ? { ok: true, asOfDate } : { ok: false, asOfDate, error: result.error };
}
