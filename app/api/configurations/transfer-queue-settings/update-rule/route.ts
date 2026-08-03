import { NextResponse } from 'next/server';
import { updateTransferQueueRule, type Operator } from '@/app/lib/transferQueueSettings';

const VALID_OPERATORS: Operator[] = ['>', '>=', '<', '<=', 'Between', 'Equal'];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const index = Number(body?.index);
    const operator = body?.operator as Operator;
    const value1 = Number(body?.value1);
    const value2 = body?.value2 === null || body?.value2 === undefined || body?.value2 === '' ? null : Number(body.value2);
    const queueResult = String(body?.queueResult ?? '').trim();

    if (
      !Number.isInteger(index) ||
      !VALID_OPERATORS.includes(operator) ||
      !Number.isFinite(value1) || value1 <= 0 ||
      !queueResult
    ) {
      return NextResponse.json({ error: 'Missing or invalid index/operator/value1/queueResult.' }, { status: 400 });
    }

    if (operator === 'Between' && (value2 === null || !Number.isFinite(value2) || value2 <= value1)) {
      return NextResponse.json({ error: '"Between" requires value2 greater than value1.' }, { status: 400 });
    }

    const { updatedBy, updatedAt } = await updateTransferQueueRule(index, operator, value1, operator === 'Between' ? value2 : null, queueResult);
    return NextResponse.json({ ok: true, updatedBy, updatedAt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error updating Transfer Queue rule';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
