/*
 * APPROVE DEPOSIT BOT — CONFIG
 *
 * Everything that depends on the SBO page layout lives here.
 * Values marked TODO must be filled from the real SBO page
 * (run `node inspect-page.js` and check its output / screenshots).
 */

const backoffice = {
  name: "SBO",

  // Deposit list page (same page the cancel bot uses)
  depositUrl:
    process.env.SBO_BO_URL ||
    "https://sbomcwgroup.net/page/mmg/payment/deposit.jsp",

  credentials: {
    username: process.env.SBO_BO_USERNAME,
    password: process.env.SBO_BO_PASSWORD
  },

  // Separate profile from the cancel bot so both can run at once.
  browserProfile: "./browser-data/sbo-approve"
};

/*
 * SAFETY
 */
const safety = {
  // Hidden switch for first-time testing only. Default OFF (live).
  // DRY_RUN=true = do every check, but never open the make up form.
  dryRun: (process.env.DRY_RUN || "false").toLowerCase() === "true",

  // Only these Telegram chats (group or user IDs) can trigger approvals.
  // Comma-separated in .env, e.g. ALLOWED_CHAT_IDS=-1001234567890,123456789
  allowedChatIds: (process.env.ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),

  // Per explicit instruction — bypasses allowedChatIds entirely so ANY
  // Telegram chat can trigger a search/approval, not just an allow-listed
  // one. A SEPARATE, explicit opt-in flag rather than just reading
  // allowedChatIds as empty-means-allow-all — an empty list left over from
  // a copy-pasted or accidentally-cleared .env must never silently open
  // this up; it has to be a deliberate ALLOW_ALL_CHATS=true.
  allowAllChats: (process.env.ALLOW_ALL_CHATS || "false").toLowerCase() === "true",

  // Shared secret every approval request must include ("Secret Key: ...")
  // — per explicit instruction, a defense layer specifically for
  // ALLOW_ALL_CHATS=true (anyone who finds the bot can message it; this
  // means a message is only ever ACTED on if it also carries the right
  // key). null when unset in .env — bot.js's own match check then fails
  // for every request (fail closed, same convention as an empty
  // allowedChatIds rejecting everything). NEVER echoed back in any reply
  // (see bot.js's buildReply, which never references req.secretKey) and
  // never written to approvals.log in full (see bot.js's audit() call).
  secretKey: process.env.SECURITY_CODE || null,

  // Posted a structured JSON summary to this URL after every successful
  // APPROVED makeup deposit, per explicit instruction — null/unset simply
  // skips it (optional feature, no error if not configured).
  webhookUrl: process.env.WEBHOOK_URL || null,

  // Telegram blocks a bot from ever seeing a message sent by ANOTHER bot
  // account in a group (confirmed live — Ops Support Team's bot-sent
  // messages never reached this bot, an identical human-sent copy did).
  // This HTTP endpoint (POST /approve, same text format + Secret Key as
  // Telegram) lets that kind of sender trigger approvals directly,
  // bypassing Telegram entirely. null/0 = endpoint disabled (default).
  httpPort: process.env.HTTP_PORT ? Number(process.env.HTTP_PORT) : null,

  // Optional — a Telegram chat/group ID the bot also posts each HTTP-
  // triggered result into, for the same human-visible audit trail a
  // Telegram-originated request gets. null = skip (HTTP caller still gets
  // the result in its own response either way).
  httpReplyChatId: process.env.HTTP_REPLY_CHAT_ID || null
};

/*
 * SBO PAGE SELECTORS
 */
const selectors = {
  // --- Deposit list search form ---
  // Confirmed from inspect-deposit.txt's real DOM dump — name="referenceNo".
  // Two elements share this name (one hidden, from a different form on the
  // same page; one visible, the real search field) — ":visible" is required
  // or Playwright throws a strict-mode "multiple elements" error on .fill().
  referenceInput: 'input[name="referenceNo"]:visible',

  // Confirmed from the same dump — name="transactionId", label "Transaction
  // ID" (user confirmed: Transaction ID = DP ID, matching the TG rule
  // "Transaction ID = the DP ID in SBO"). Several OTHER transactionId
  // elements exist but are all type="hidden" (never visible), so ":visible"
  // alone is enough to isolate the one real text field — not the separate
  // "PG Transaction ID" field also on this form, a different ID entirely.
  dpIdInput: 'input[name="transactionId"]:visible',

  // Brand dropdown — confirmed id="websiteType", "All" option value is "-1"
  // (dump: "-1 = All"), not "" as originally guessed.
  websiteTypeSelect: "#websiteType",
  websiteTypeAllValue: "-1",

  // Status dropdown — confirmed id="status", options "9999=All, 0=Pending,
  // 2=Approved, -2=Disapproved". "All" value is "9999", not "" as
  // originally guessed — a blank "" would not have matched any real
  // <option>, so selectIfPossible's .selectOption() would have silently
  // failed every search (caught/logged, never thrown, so this would NOT
  // have surfaced as an error — just silently left Status on whatever it
  // last was).
  statusSelect: "#status",
  statusAllValue: "9999",

  // Search button (exact visible text)
  searchButtonText: "Search",

  // Created Time Range — SBO pre-fills this (seen live: today's own 24h
  // window) on every page load, which silently excludes any deposit
  // outside that window from search results. Per explicit instruction,
  // cleared before every search (see sbo.js's search()) so a search is
  // never accidentally date-limited. Confirmed exact ids from the DOM
  // dump — id="createDateStart"/"createDateEnd" — distinct from "Approved
  // Time Range"'s own separate id="approvedDateStart"/"approvedDateEnd",
  // so no ambiguity risk (upgraded from an earlier placeholder-based
  // .first() guess, before these exact ids were confirmed).
  createdTimeRangeFromInput: "#createDateStart",
  createdTimeRangeToInput: "#createDateEnd",

  // --- Results table ---
  // Confirmed from the DOM dump — id="depositSearchTable", the one table
  // whose headers exactly match every column seen live in the screenshots
  // (Transaction ID, Reference No., Status, etc.).
  resultsTable: "#depositSearchTable",

  // Column header texts in the results table — confirmed EXACT from real
  // SBO screenshots/DOM dump, matched exactly (not "includes") by sbo.js's
  // readResults(). Must stay exact: the real table has several headers
  // that share a word with these — "Account status" vs "Status", and
  // "Deposit Amount"/"Real Amount"/"Bonus Amount"/"Total Amount" all
  // contain "amount" — a partial match picked "Account status" instead of
  // "Status" (confirmed live, broke the Approved/Disapproved check this
  // whole bot depends on). "amount" maps to "Real Amount" specifically —
  // the same field TG's own Amount gets submitted into (see
  // makeupAmountPlaceholder below) — not "Amount" alone, which doesn't
  // exist as a header at all. Note the results table's own "Transaction
  // ID" column is the SAME field as the search form's "Transaction ID"
  // input (both = the DP ID) — not "PG Transaction ID", a separate column.
  columns: {
    dpId: "Transaction ID",
    reference: "Reference No.",
    amount: "Real Amount",
    status: "Status"
  },

  // Status text SBO shows for an approved deposit (whole-word match,
  // so "Disapproved" is NOT treated as approved)
  approvedStatusTexts: ["approved", "success"],

  // --- New Make up deposit modal (from SBO screenshot) ---
  // Confirmed from the Deposit page screenshot — a blue "Make up deposit"
  // button sits next to Create/Search at the bottom of the Condition Panel
  // (not tied to the results table). Confirmed from the modal screenshot
  // too: it opens with every field blank (no pre-filled row data), exactly
  // matching the current code's direct click with no row-selection step.
  makeupOpenButtonText: "Make up deposit",

  makeupModal: ".modal, [role=dialog]",
  makeupModalTitle: "New Make up deposit",

  // Field placeholders as shown in SBO
  makeupDpIdPlaceholder: /original\s+transaction\s+id/i,
  makeupReferencePlaceholder: /reference no/i,
  makeupAmountPlaceholder: /real amount/i,

  // Optional text for the Remark box ("" = leave empty)
  makeupRemark: "TG bot approval",

  makeupCheckButtonText: "Check",

  // Confirmed live (2026-10-01 manual walkthrough): after a successful
  // Check, SBO shows a green "Check Pass" banner and the modal gains a
  // "Submit" button next to "Reset" — this exact text, not a guess. Its
  // presence + enabled state IS the pass/fail signal sbo.js's
  // makeupDeposit() uses (see that function's own comment for why, not
  // text-matching an unconfirmed error banner).
  makeupSubmitButtonText: "Submit",

  // Where SBO shows error / warning text (read as the "reason")
  errorTextSelectors:
    ".modal .alert-danger, .modal .text-danger, .modal .help-block, .modal .error, " +
    ".toast-message, .swal2-html-container, .bootbox-body, .layui-layer-content"
};

const REQUIRED_SELECTORS = [
  "referenceInput",
  "dpIdInput",
  "resultsTable",
  "makeupOpenButtonText"
];

function missingSelectors() {
  return REQUIRED_SELECTORS.filter((key) => !selectors[key]);
}

module.exports = {
  backoffice,
  safety,
  selectors,
  missingSelectors
};
