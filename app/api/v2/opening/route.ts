import { NextResponse } from 'next/server';
import { getCashoutOpeningRows } from '@/app/lib/services/openingPageService';
import { updateOpeningAgents, deleteOpeningAgent, createOpeningAgent, OpeningActionError, type OpeningFieldUpdates, type NewOpeningAgent } from '@/app/lib/services/openingActionsService';

// Phase 5 — Postgres-backed Today's Opening for Cashout (app/summary).
export async function GET() {
  try {
    const rows = await getCashoutOpeningRows();
    return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load Opening data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Phase 7 — Single Edit and Bulk Edit share this one endpoint: agentCodes
// is [oneCode] for Single Edit, or the full selection for Bulk Edit. Both
// always resolve to the same one-transaction, all-or-nothing service call.
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const agentCodes = body?.agentCodes;
    const updates: OpeningFieldUpdates = body?.updates ?? {};
    if (!Array.isArray(agentCodes) || agentCodes.some((c) => typeof c !== 'string')) {
      return NextResponse.json({ error: 'agentCodes must be a non-empty array of strings.' }, { status: 400 });
    }
    const result = await updateOpeningAgents('cashout', agentCodes, updates);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OpeningActionError) return NextResponse.json({ error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : 'Update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const agentCode = body?.agentCode;
    if (typeof agentCode !== 'string' || !agentCode.trim()) {
      return NextResponse.json({ error: 'agentCode is required.' }, { status: 400 });
    }
    const result = await deleteOpeningAgent('cashout', agentCode);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OpeningActionError) return NextResponse.json({ error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// "New Account" — a real INSERT, never an upsert. Rejects with 409 if the
// agentCode already exists for this product (see createOpeningAgent's own
// comment).
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const input: NewOpeningAgent = body ?? {};
    if (typeof input.agentCode !== 'string' || !input.agentCode.trim()) {
      return NextResponse.json({ error: 'Agent Name is required.' }, { status: 400 });
    }
    const result = await createOpeningAgent('cashout', input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof OpeningActionError) return NextResponse.json({ error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : 'Create failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
