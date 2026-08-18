import { NextResponse } from 'next/server';
import { getTopUpRows } from '@/app/lib/services/transactionPageService';
import { updateTransactions, deleteTransaction, createTransaction, TransactionActionError, type TransactionFieldUpdates, type NewTransaction } from '@/app/lib/services/transactionActionsService';

// Phase 7 — Postgres-backed Top Up for Cashout (app/topup).
export async function GET() {
  try {
    const rows = await getTopUpRows('cashout');
    return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load Top Up data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const ids = body?.ids;
    const updates: TransactionFieldUpdates = body?.updates ?? {};
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'number')) {
      return NextResponse.json({ error: 'ids must be a non-empty array of numbers.' }, { status: 400 });
    }
    const result = await updateTransactions('cashout', 'topup', ids, updates);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TransactionActionError) return NextResponse.json({ error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : 'Update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const id = body?.id;
    if (typeof id !== 'number') {
      return NextResponse.json({ error: 'id is required.' }, { status: 400 });
    }
    const result = await deleteTransaction('cashout', 'topup', id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TransactionActionError) return NextResponse.json({ error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const input: NewTransaction = body ?? {};
    if (typeof input.agentName !== 'string' || !input.agentName.trim()) {
      return NextResponse.json({ error: 'Agent Name is required.' }, { status: 400 });
    }
    const result = await createTransaction('cashout', 'topup', input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof TransactionActionError) return NextResponse.json({ error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : 'Create failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
