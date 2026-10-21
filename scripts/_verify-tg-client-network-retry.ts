// Verifies discrepancyTgTelegramClient's network-error handling with a fake
// fetch — no real Telegram calls. A dropped connection must be retried, and
// if it keeps failing, returned as a normal failure (never thrown).
// Run with: npx tsx scripts/_verify-tg-client-network-retry.ts
import { sendAlbum, sendDocument } from '../app/lib/server/discrepancyTgTelegramClient';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`}`);
}

const netErr = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
const okRes = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
let calls = 0;
function fakeFetch(plan: ('net' | 'ok')[]) {
  calls = 0;
  globalThis.fetch = (async () => {
    const step = plan[Math.min(calls++, plan.length - 1)];
    if (step === 'net') throw netErr();
    return okRes();
  }) as typeof fetch;
}

const img = [Buffer.from('x')];
const pdf = Buffer.from('%PDF');

(async () => {
  fakeFetch(['net', 'ok']);
  check('album: 1 network error then success -> ok', await sendAlbum('t', 'c', img, 'cap'), { ok: true });
  check('album: retried once (2 calls)', calls, 2);

  fakeFetch(['net', 'net', 'net']);
  let threw = false;
  let res: unknown;
  try { res = await sendAlbum('t', 'c', img, 'cap'); } catch { threw = true; }
  check('album: network error x3 -> does NOT throw', threw, false);
  check('album: network error x3 -> failed with real cause', res, { ok: false, error: 'Network error: ECONNRESET' });
  check('album: 3 attempts', calls, 3);

  fakeFetch(['net', 'net', 'ok']);
  check('pdf: 2 network errors then success -> ok', await sendDocument('t', 'c', pdf, 'f.pdf', undefined), { ok: true });

  fakeFetch(['net', 'net', 'net']);
  threw = false;
  try { res = await sendDocument('t', 'c', pdf, 'f.pdf', undefined); } catch { threw = true; }
  check('pdf: network error x3 -> does NOT throw', threw, false);
  check('pdf: network error x3 -> failed with real cause', res, { ok: false, error: 'Network error: ECONNRESET' });

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
