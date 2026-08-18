// PostgreSQL read-layer mirror of the Wallet Status reads
// (readCashout/SendMoneyWalletStatus + Remarks + Overrides, merged via
// mergeWalletStatusRemarksAndOverrides() in app/lib/walletStatus.ts, served
// by /api/wallet-status and /api/sendmoney/wallet-status).
//
// wallet_status_overrides already stores the fully-merged shape (one row
// per agent-or-wallet covering status/remark/override fields together), so
// reproducing MergedWalletSettingsEntry is a direct 1:1 field mapping, not
// a re-merge of three separate sources.
//
// Output shape: Record<string, MergedWalletSettingsEntry> keyed by SHOP KEY
// — matching the real merge function's return type exactly, including its
// default-fill behavior for any field a stored row leaves null/unset
// (DEFAULT_WALLET_STATUS_ENTRY / DEFAULT_WALLET_REMARK_ENTRY /
// DEFAULT_WALLET_OVERRIDE_ENTRY from app/lib/walletStatus.ts). "Shop key"
// is product-dependent, matching the live pages' own lookup keys exactly:
// Cashout is genuinely per-WALLET (a shop's Bkash/Nagad/Rocket/UPay wallets
// can carry different remarks — confirmed via real data: of 2,251 real,
// wallet-linked Cashout agents, 1,210 have 2+ wallets), so its key is
// `${agentCode}-${walletTypeSuffix}` (e.g. "JETT003-BK"), sourced from a
// row with wallet_id set. Send Money is genuinely per-SHOP (its own
// Balance Limit model is "every shop solo" — only 27 of 11,273 agents have
// more than one wallet), so its key is the bare agentCode, sourced from a
// row with wallet_id null. This mirrors app/wallet-status/page.tsx's own
// walletCode construction and app/sendmoney/wallet-status/page.tsx's own
// bare-agentCode keying exactly — see walletStatusConfigService.ts's
// resolveTarget() for the write-side counterpart of this same mapping.
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import * as schema from '../schema';

export type Product = 'cashout' | 'sendmoney';

// Same abbreviations as app/wallet-status/page.tsx's own
// WALLET_TYPE_ABBREVIATIONS — kept in sync manually (small, stable map,
// same reasoning as that file's own duplicate-vs-import tradeoff note).
const WALLET_TYPE_ABBREVIATIONS: Record<string, string> = { BKASH: 'BK', NAGAD: 'NG', ROCKET: 'RK', UPAY: 'UP' };

export type MergedWalletSettingsEntry = {
  deposit: 'Yes' | 'No';
  withdrawal: 'Yes' | 'No';
  priority: 'Low' | 'Normal' | 'High';
  walletStatus: 'Active' | 'Inactive' | 'Suspended' | '';
  remark: string;
  updatedBy: string;
  updatedAt: string;
  mainReason: string;
  closureType: string;
  affectedServices: string[];
  minimumAmountCanTake: number | null;
  balanceLimitOverride: number | null;
  scheduleOverride: string;
};

export async function readWalletStatusOverridesPg(product: Product): Promise<Record<string, MergedWalletSettingsEntry>> {
  const db = getDb();
  const rows = await db
    .select({
      agentCode: schema.agents.agentCode,
      walletTypeCode: schema.walletTypes.code,
      depositEnabled: schema.walletStatusOverrides.depositEnabled,
      withdrawalEnabled: schema.walletStatusOverrides.withdrawalEnabled,
      priority: schema.walletStatusOverrides.priority,
      status: schema.walletStatusOverrides.status,
      remark: schema.walletStatusOverrides.remark,
      remarkUpdatedBy: schema.walletStatusOverrides.remarkUpdatedBy,
      remarkUpdatedAt: schema.walletStatusOverrides.remarkUpdatedAt,
      mainReason: schema.walletStatusOverrides.mainReason,
      closureType: schema.walletStatusOverrides.closureType,
      affectedServices: schema.walletStatusOverrides.affectedServices,
      minimumAmountCanTake: schema.walletStatusOverrides.minimumAmountCanTake,
      balanceLimitOverride: schema.walletStatusOverrides.balanceLimitOverride,
      scheduleOverride: schema.walletStatusOverrides.scheduleOverride,
    })
    .from(schema.walletStatusOverrides)
    .innerJoin(schema.agents, eq(schema.walletStatusOverrides.agentId, schema.agents.id))
    .leftJoin(schema.agentWallets, eq(schema.walletStatusOverrides.walletId, schema.agentWallets.id))
    .leftJoin(schema.walletTypes, eq(schema.agentWallets.walletTypeId, schema.walletTypes.id))
    .where(eq(schema.agents.product, product));

  const result: Record<string, MergedWalletSettingsEntry> = {};
  for (const r of rows) {
    // Cashout rows are wallet-scoped (walletTypeCode resolved via the left
    // joins above) — key matches the live page's own walletCode exactly.
    // Send Money rows are agent-scoped (walletTypeCode null) — key is the
    // bare agentCode, matching that page's own lookup.
    const suffix = r.walletTypeCode ? WALLET_TYPE_ABBREVIATIONS[r.walletTypeCode] ?? '' : '';
    const key = suffix ? `${r.agentCode}-${suffix}` : r.agentCode;
    result[key] = {
      deposit: r.depositEnabled ? 'Yes' : 'No',
      withdrawal: r.withdrawalEnabled ? 'Yes' : 'No',
      priority: r.priority,
      walletStatus: r.status ?? '',
      remark: r.remark ?? '',
      updatedBy: r.remarkUpdatedBy ?? '',
      updatedAt: r.remarkUpdatedAt ? r.remarkUpdatedAt.toISOString() : '',
      mainReason: r.mainReason ?? '',
      closureType: r.closureType ?? '',
      affectedServices: r.affectedServices ?? [],
      minimumAmountCanTake: r.minimumAmountCanTake === null ? null : Number(r.minimumAmountCanTake),
      balanceLimitOverride: r.balanceLimitOverride === null ? null : Number(r.balanceLimitOverride),
      scheduleOverride: r.scheduleOverride ?? '',
    };
  }
  return result;
}
