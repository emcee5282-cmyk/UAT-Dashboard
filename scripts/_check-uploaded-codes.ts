// One-off: check shop codes from the user's uploaded Opening file against
// the current cashout agents roster, using the exact same match key
// importOpeningFile() uses (agentCode.trim().toLowerCase()).
// Run with: npx tsx --env-file=.env.local scripts/_check-uploaded-codes.ts
import fs from 'fs';
import { eq } from 'drizzle-orm';
import { getDb } from '../app/lib/db/client';
import * as schema from '../app/lib/db/schema';

const FILES = [
  'C:\\Users\\ejboy\\AppData\\Local\\Temp\\claude\\c--Users-ejboy-Desktop-dashbaord-project\\4391fe8a-6e79-459a-875a-4e54e930e816\\scratchpad\\uploaded-codes.txt',
  'C:\\Users\\ejboy\\AppData\\Local\\Temp\\claude\\c--Users-ejboy-Desktop-dashbaord-project\\4391fe8a-6e79-459a-875a-4e54e930e816\\scratchpad\\uploaded-codes-2.txt',
];

async function main() {
  const db = getDb();
  const codes = FILES.flatMap((f) =>
    fs.readFileSync(f, 'utf-8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  );

  const agentRows = await db
    .select({ agentCode: schema.agents.agentCode })
    .from(schema.agents)
    .where(eq(schema.agents.product, 'cashout'));
  const rosterSet = new Set(agentRows.map((a) => a.agentCode.trim().toLowerCase()));

  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const code of codes) {
    if (rosterSet.has(code.toLowerCase())) matched.push(code);
    else unmatched.push(code);
  }

  console.log(`Checked ${codes.length} codes total.`);
  console.log(`  Matched:   ${matched.length}`);
  console.log(`  Unmatched: ${unmatched.length}`);
  if (unmatched.length > 0) {
    console.log('\nUnmatched codes:');
    unmatched.forEach((c) => console.log('  ' + c));
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
