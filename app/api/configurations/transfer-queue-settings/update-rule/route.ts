import { NextResponse } from 'next/server';
import { updateTransferQueueRule, VALID_OPERATORS, type Operator } from '@/app/lib/transferQueueSettings';
import { updateTransferQueueRulePg } from '@/app/lib/services/transferQueueConfigService';

// Same shared flag as the sibling GET route — see its own comment.
function isPostgresSourceEnabled(): boolean {
  return process.env.TRANSFER_QUEUE_CONFIG_SOURCE === 'postgres';
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const index = Number(body?.index);
    const operator = body?.operator as Operator;
    const value1 = Number(body?.value1);
    const value2 = body?.value2 === null || body?.value2 === undefined || body?.value2 === '' ? null : Number(body.value2);
    const queueResult = String(body?.queueResult ?? '').trim();
    const enabled = Boolean(body?.enabled);

    if (!Number.isInteger(index) || !VALID_OPERATORS.includes(operator)) {
      return NextResponse.json({ error: 'Missing or invalid index/operator.' }, { status: 400 });
    }

    // A disabled row is deliberately allowed to hold a placeholder/blank
    // value — the whole point of Enabled is to let an admin say "don't
    // apply this yet" without needing a real Value/Queue Result first.
    if (enabled) {
      if (!Number.isFinite(value1) || value1 <= 0 || !queueResult) {
        return NextResponse.json({ error: 'Missing or invalid value1/queueResult.' }, { status: 400 });
      }
      if (operator === 'Between' && (value2 === null || !Number.isFinite(value2) || value2 <= value1)) {
        return NextResponse.json({ error: '"Between" requires value2 greater than value1.' }, { status: 400 });
      }
    }

    if (isPostgresSourceEnabled()) {
      // Postgres rule ids were seeded in DEFAULT_RULES' exact flat order
      // starting at 1 (scripts/migrate-data.ts's importTransferQueueRules())
      // — confirmed live against all 46 rows before relying on it, id ===
      // index + 1 holds universally, so this index (the same one Sheets
      // mode has always used, unchanged on the client) maps directly, no
      // separate lookup table needed.
      const id = index + 1;
      const { updatedBy, updatedAt } = await updateTransferQueueRulePg(id, {
        operator,
        value1,
        value2: operator === 'Between' ? value2 : null,
        queueResult,
        enabled,
      });
      return NextResponse.json({ ok: true, updatedBy, updatedAt }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const { updatedBy, updatedAt } = await updateTransferQueueRule(index, operator, value1, operator === 'Between' ? value2 : null, queueResult, enabled);
    return NextResponse.json({ ok: true, updatedBy, updatedAt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error updating Transfer Queue rule';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
