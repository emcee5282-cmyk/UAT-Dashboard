import { NextResponse } from 'next/server';
import { importOpeningFile, type Product, type NewShopDecision } from '@/app/lib/services/importService';

// LOCAL/FOUNDATION ONLY — see app/api/v2/import/settlement/route.ts for the
// full explanation. Opening is structurally different (updates
// agents.opening_balance/sdp directly, no wallet_transactions rows) — see
// importOpeningFile()'s own comment in importService.ts.
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const product = formData.get('product');
    const uploadedBy = formData.get('uploadedBy');
    const excludedRowsRaw = formData.get('excludedRows');
    const newShopDecisionsRaw = formData.get('newShopDecisions');
    const sdpSkipRowsRaw = formData.get('sdpSkipRows');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    }
    if (product !== 'cashout' && product !== 'sendmoney') {
      return NextResponse.json({ error: 'Missing or invalid product (expected "cashout" or "sendmoney")' }, { status: 400 });
    }

    let excludedRows: Set<number> | undefined;
    if (typeof excludedRowsRaw === 'string' && excludedRowsRaw) {
      const parsed = JSON.parse(excludedRowsRaw);
      if (Array.isArray(parsed)) excludedRows = new Set(parsed.filter((n) => typeof n === 'number'));
    }

    // Client-gated (BulkImportModal.tsx's New Shops panel blocks Continue
    // until every unmatched row has one of these) — loosely validated here,
    // not re-derived; importOpeningFile stays defensive for anything
    // malformed or missing (see its own comment on NewShopDecision).
    let newShopDecisions: Record<number, NewShopDecision> | undefined;
    if (typeof newShopDecisionsRaw === 'string' && newShopDecisionsRaw) {
      const parsed = JSON.parse(newShopDecisionsRaw);
      if (parsed && typeof parsed === 'object') {
        newShopDecisions = {};
        for (const [key, value] of Object.entries(parsed)) {
          const row = Number(key);
          if (!Number.isFinite(row) || !value || typeof value !== 'object') continue;
          const decision = value as Record<string, unknown>;
          if (decision.action === 'insert' && typeof decision.leader === 'string') {
            newShopDecisions[row] = { action: 'insert', leader: decision.leader };
          } else if (decision.action === 'link' && typeof decision.agentCode === 'string') {
            newShopDecisions[row] = { action: 'link', agentCode: decision.agentCode };
          }
        }
      }
    }

    // SDP-change confirmation (Phase 2) — row numbers whose SDP the user
    // chose to Skip; the rest of that row still imports normally.
    let sdpSkipRows: Set<number> | undefined;
    if (typeof sdpSkipRowsRaw === 'string' && sdpSkipRowsRaw) {
      const parsed = JSON.parse(sdpSkipRowsRaw);
      if (Array.isArray(parsed)) sdpSkipRows = new Set(parsed.filter((n) => typeof n === 'number'));
    }

    const result = await importOpeningFile({
      product: product as Product,
      file,
      fileName: file.name,
      uploadedBy: typeof uploadedBy === 'string' && uploadedBy ? uploadedBy : 'unknown',
      excludedRows,
      newShopDecisions,
      sdpSkipRows,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
