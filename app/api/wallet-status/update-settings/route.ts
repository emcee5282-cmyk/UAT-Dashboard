import { NextResponse } from 'next/server';
import { updateCashoutWalletSettings, type MainReason, type ClosureType, type AffectedService, type ScheduleOverride } from '@/app/lib/walletStatus';

const MAX_REMARK_LENGTH = 500;
const VALID_MAIN_REASONS: MainReason[] = ['', 'Closed by Operations', 'High Running Balance', 'Reduce as per Leader', 'Wallet Issue', 'Blocked by Wallet Office', 'Others'];
const VALID_CLOSURE_TYPES: ClosureType[] = ['', 'Temporary Close', 'Permanent Close'];
const VALID_AFFECTED_SERVICES: AffectedService[] = ['Deposit', 'Withdrawal'];
const VALID_SCHEDULE_OVERRIDES: ScheduleOverride[] = ['', 'Day', 'Extended', 'Early Ext.', '24/7'];

// Single-wallet save for the unified Edit Wallet Settings modal — one
// request for all fields (Remarks, Main Reason, Closure Type, Affected
// Services, Minimum Amount Can Take, Balance Limit, Schedule). Priority is
// NOT part of this route — the modal no longer edits it.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const shopName = String(body?.shopName ?? '').trim();
    const remark = String(body?.remark ?? '').trim();
    const mainReason = String(body?.mainReason ?? '') as MainReason;
    const closureType = String(body?.closureType ?? '') as ClosureType;
    const scheduleOverride = String(body?.scheduleOverride ?? '') as ScheduleOverride;
    const rawAffectedServices = Array.isArray(body?.affectedServices) ? body.affectedServices : [];
    const affectedServices = rawAffectedServices.filter((s: unknown): s is AffectedService => VALID_AFFECTED_SERVICES.includes(s as AffectedService));

    const parseAmount = (raw: unknown): number | null | undefined => {
      if (raw === null || raw === undefined || raw === '') return null;
      const num = Number(raw);
      return isNaN(num) ? undefined : num;
    };
    const minimumAmountCanTake = parseAmount(body?.minimumAmountCanTake);
    const balanceLimitOverride = parseAmount(body?.balanceLimitOverride);

    if (!shopName || remark.length > MAX_REMARK_LENGTH) {
      return NextResponse.json({ error: 'Missing or invalid shopName/remark.' }, { status: 400 });
    }
    if (!VALID_MAIN_REASONS.includes(mainReason) || !VALID_CLOSURE_TYPES.includes(closureType) || !VALID_SCHEDULE_OVERRIDES.includes(scheduleOverride)) {
      return NextResponse.json({ error: 'Invalid mainReason/closureType/scheduleOverride.' }, { status: 400 });
    }
    if (minimumAmountCanTake === undefined || balanceLimitOverride === undefined) {
      return NextResponse.json({ error: 'Invalid minimumAmountCanTake/balanceLimitOverride.' }, { status: 400 });
    }

    const { updatedBy, updatedAt } = await updateCashoutWalletSettings(shopName, {
      remark, mainReason, closureType, affectedServices, minimumAmountCanTake, balanceLimitOverride, scheduleOverride,
    });
    return NextResponse.json({ ok: true, updatedBy, updatedAt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error updating wallet settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
