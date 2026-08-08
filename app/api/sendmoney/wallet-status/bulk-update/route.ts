import { NextResponse } from 'next/server';
import { updateSendMoneyWalletStatusBulk, type Priority, type MainReason, type ClosureType, type AffectedService, type ScheduleOverride, type WalletStatusBulkUpdate } from '@/app/lib/walletStatus';

const VALID_PRIORITIES: Priority[] = ['Low', 'Normal', 'High'];
const VALID_MAIN_REASONS: MainReason[] = ['', 'Closed by Operations', 'High Running Balance', 'Reduce as per Leader', 'Wallet Issue', 'Blocked by Wallet Office', 'Others'];
const VALID_CLOSURE_TYPES: ClosureType[] = ['', 'Temporary Close', 'Permanent Close'];
const VALID_AFFECTED_SERVICES: AffectedService[] = ['Deposit', 'Withdrawal'];
const VALID_SCHEDULE_OVERRIDES: ScheduleOverride[] = ['', 'Day', 'Extended', 'Early Ext.', '24/7'];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const rawUpdates = Array.isArray(body?.updates) ? body.updates : [];

    const updates: WalletStatusBulkUpdate[] = rawUpdates
      .map((u: unknown) => {
        const entry = u as {
          shopName?: unknown; priority?: unknown; remark?: unknown;
          mainReason?: unknown; closureType?: unknown; affectedServices?: unknown;
          minimumAmountCanTake?: unknown; balanceLimitOverride?: unknown; scheduleOverride?: unknown;
        };
        const shopName = String(entry?.shopName ?? '').trim();
        const priorityRaw = entry?.priority !== undefined ? String(entry.priority).trim() : undefined;
        const priority = priorityRaw && VALID_PRIORITIES.includes(priorityRaw as Priority) ? (priorityRaw as Priority) : undefined;
        // Remark is legitimately allowed to be an empty string (clearing a
        // remark in bulk) — only `undefined` means "not part of this edit".
        const remark = typeof entry?.remark === 'string' ? entry.remark : undefined;
        const mainReasonRaw = entry?.mainReason !== undefined ? String(entry.mainReason).trim() : undefined;
        const mainReason = mainReasonRaw !== undefined && VALID_MAIN_REASONS.includes(mainReasonRaw as MainReason) ? (mainReasonRaw as MainReason) : undefined;
        const closureTypeRaw = entry?.closureType !== undefined ? String(entry.closureType).trim() : undefined;
        const closureType = closureTypeRaw !== undefined && VALID_CLOSURE_TYPES.includes(closureTypeRaw as ClosureType) ? (closureTypeRaw as ClosureType) : undefined;
        const affectedServices = Array.isArray(entry?.affectedServices)
          ? (entry.affectedServices as unknown[]).filter((s): s is AffectedService => VALID_AFFECTED_SERVICES.includes(s as AffectedService))
          : undefined;
        const scheduleOverrideRaw = entry?.scheduleOverride !== undefined ? String(entry.scheduleOverride).trim() : undefined;
        const scheduleOverride = scheduleOverrideRaw !== undefined && VALID_SCHEDULE_OVERRIDES.includes(scheduleOverrideRaw as ScheduleOverride) ? (scheduleOverrideRaw as ScheduleOverride) : undefined;

        // null is a legitimate, intentional "clear the value" — only
        // `undefined` (the key never sent) means "not part of this edit".
        const parseAmount = (raw: unknown): number | null | undefined => {
          if (raw === undefined) return undefined;
          if (raw === null || raw === '') return null;
          const num = Number(raw);
          return isNaN(num) ? undefined : num;
        };
        const minimumAmountCanTake = parseAmount(entry?.minimumAmountCanTake);
        const balanceLimitOverride = parseAmount(entry?.balanceLimitOverride);

        return { shopName, priority, remark, mainReason, closureType, affectedServices, minimumAmountCanTake, balanceLimitOverride, scheduleOverride };
      })
      .filter((u: WalletStatusBulkUpdate) =>
        u.shopName && (
          u.priority !== undefined || u.remark !== undefined || u.mainReason !== undefined || u.closureType !== undefined
          || u.affectedServices !== undefined || u.minimumAmountCanTake !== undefined || u.balanceLimitOverride !== undefined || u.scheduleOverride !== undefined
        )
      );

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No valid updates provided.' }, { status: 400 });
    }

    const result = await updateSendMoneyWalletStatusBulk(updates);
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error applying bulk update';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
