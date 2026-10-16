/*
 * Parse approval requests from a Telegram message.
 *
 * Accepted formats (one or more blocks per message, blank line between blocks):
 *
 *   RefCode: 75GD3W3K
 *   Amount: 200
 *   Transaction ID: D1370154318
 *
 * or the same three values on three lines without labels, in that order.
 *
 * Label aliases: RefCode/Reference/Ref/TrxID, Amount/Amt, Transaction ID/TID/DP ID.
 */

const LABELS = {
  brand: /^(brand)$/i,
  reference: /^(ref ?code|reference|ref|ref no|reference no|trx ?id|trxid)$/i,
  amount: /^(amount|amt)$/i,
  tid: /^(transaction ?id|trans ?id|txn ?id|tid|dp ?id|dpid|deposit ?id)$/i
};

// Used only to recognize a "Secret Key" (or similarly-labeled) line so it
// can be excluded from block-splitting below — not used to extract the
// key's value. Value is intentionally NOT required on the same line here:
// real messages were seen with the key on its own line right after the
// label (e.g. "Secret Key:\n<value>"), and even with a mistyped label
// ("Secket Key:"). Matching the key's actual VALUE (see containsSecretKey
// below) is label-independent, so this regex only needs to be good enough
// to keep a label-only line out of the RefCode/Amount/TID block parser.
const SECRET_KEY_LABEL_LINE = /^\s*(secret ?key|security ?code|secret|key|code)\s*[:：\-=]?\s*.*$/i;

function cleanAmount(raw) {
  if (!raw) return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// True if `text` contains `secretKey` anywhere, on any line, in any
// position — a plain substring check, not a "Secret Key:" label match.
// Deliberately label-independent: a mistyped label ("Secket Key") or the
// value landing on its own line (both seen live) must never reject a
// message that otherwise has the correct key. The key is long and random
// enough that an accidental substring match elsewhere in a message isn't
// a realistic concern. Case-sensitive — the key's exact case still matters.
function containsSecretKey(text, secretKey) {
  return Boolean(text && secretKey && text.includes(secretKey));
}

function parseBlock(lines) {
  const req = { brand: null, reference: null, amount: null, tid: null };
  const unlabeled = [];

  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z .]+?)\s*[:：\-=]\s*(.+)$/);
    let matched = false;

    if (m) {
      const label = m[1].trim();
      const value = m[2].trim();
      for (const [key, re] of Object.entries(LABELS)) {
        if (re.test(label)) {
          req[key] = value;
          matched = true;
          break;
        }
      }
    }

    if (!matched) unlabeled.push(line.trim());
  }

  // Fallback: three unlabeled lines = Reference, Amount, TID
  if (!req.reference && !req.amount && !req.tid && unlabeled.length === 3) {
    [req.reference, req.amount, req.tid] = unlabeled;
  }

  const amount = cleanAmount(req.amount);

  if (!req.reference || !req.tid || !amount) return null;

  return {
    brand: req.brand ? req.brand.replace(/\s+/g, "") : null,
    reference: req.reference.replace(/\s+/g, ""),
    amount,
    amountRaw: req.amount,
    tid: req.tid.replace(/\s+/g, "")
  };
}

// A "Secret Key: ..." line (label alone, or label + value) is a
// standalone block once split by blank lines — filtered out here so it's
// never mistaken for an incomplete/invalid RefCode block. Likewise a lone
// "For Approval" header line (with or without a trailing colon).
function parseRequests(text) {
  if (!text) return [];

  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.split("\n").map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length > 0 && !(b.length === 1 && (SECRET_KEY_LABEL_LINE.test(b[0]) || /^for approval:?$/i.test(b[0]))));

  return blocks.map(parseBlock).filter(Boolean);
}

module.exports = { parseRequests, cleanAmount, containsSecretKey };
