require("dotenv").config();

const path = require("path");
const { chromium } = require("playwright");
const {
  backoffice,
  safety,
  selectors,
  missingSelectors
} = require("./config");
const { cleanAmount } = require("./parser");

let activeContext = null;

/* ------------------------------------------------------------------ */
/* Browser + login (same approach as the cancel bot)                   */
/* ------------------------------------------------------------------ */

async function getPage() {
  if (!activeContext) {
    const profilePath = path.resolve(backoffice.browserProfile);
    console.log(`[SBO] Starting browser profile: ${profilePath}`);

    activeContext = await chromium.launchPersistentContext(profilePath, {
      headless: (process.env.HEADLESS || "true").toLowerCase() !== "false",
      // Optional: use a specific Chrome/Chromium instead of Playwright's bundled one
      executablePath: process.env.CHROMIUM_PATH || undefined,
      // Delay (ms) between each browser action so you can follow it by eye
      slowMo: Number(process.env.SLOW_MO || 0),
      viewport: { width: 1440, height: 900 }
    });
  }

  const pages = activeContext.pages();
  return pages.length > 0 ? pages[0] : activeContext.newPage();
}

async function isLoginPage(page) {
  if (page.url().toLowerCase().includes("login.jsp")) return true;
  return page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
}

async function firstVisible(page, list) {
  for (const sel of list) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      return loc;
    }
  }
  return null;
}

async function openDepositPage() {
  const { username, password } = backoffice.credentials;
  if (!username || !password) throw new Error("Missing SBO credentials in .env");

  const page = await getPage();

  await page.goto(backoffice.depositUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await page.waitForTimeout(800);

  if (!(await isLoginPage(page))) return page;

  console.log("[SBO] Session expired. Logging in...");

  const userField = await firstVisible(page, [
    'input[name="username"]',
    'input[id="username"]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[type="text"]'
  ]);
  if (!userField) throw new Error("SBO login username field not found.");

  await userField.fill(username);
  await page.locator('input[type="password"]').first().fill(password);

  const loginBtn = await firstVisible(page, [
    'button:has-text("Login")',
    'button:has-text("Log In")',
    'input[type="submit"]',
    'input[value*="login" i]',
    'button[type="submit"]',
    'a:has-text("Login")'
  ]);
  if (!loginBtn) throw new Error("SBO login button not found.");

  await loginBtn.click();
  await page.waitForTimeout(2000);

  await page.goto(backoffice.depositUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await page.waitForTimeout(800);

  if (await isLoginPage(page)) throw new Error("SBO login failed.");

  console.log("[SBO] Logged in.");
  return page;
}

/* ------------------------------------------------------------------ */
/* STOPPED — a verified hard-guard failure. Thrown the moment anything  */
/* can't be confirmed, so a step never silently falls through to the    */
/* next one on bad/stale state. Distinct from an unexpected runtime     */
/* error (which still propagates and surfaces as the generic ERROR      */
/* reply in bot.js) — this is specifically "we checked, it's wrong, we  */
/* refuse to guess what to do next."                                    */
/* ------------------------------------------------------------------ */
class StoppedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "StoppedError";
    this.reason = reason;
  }
}

/* ------------------------------------------------------------------ */
/* Search + read results table                                         */
/* ------------------------------------------------------------------ */

async function selectIfPossible(page, selector, value) {
  if (!selector) return;
  const loc = page.locator(selector);
  if ((await loc.count()) === 0) return;
  await loc.selectOption(value).catch((e) => {
    console.log(`[SBO] Could not set ${selector}=${value}: ${e.message}`);
  });
}

async function clickSearch(page) {
  await page
    .getByRole("button", { name: selectors.searchButtonText, exact: true })
    .click();
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
}

/*
 * Returns { headers, colIndex, rows } — headers/colIndex are always
 * returned even when rows is empty. Hard guard: a caller must be able to
 * tell "this column genuinely doesn't exist in this result set" apart
 * from "this column exists and genuinely has zero matching rows" — the
 * old version only attached colIndex to each ROW object, so an empty
 * rows array (the exact case that matters most) carried no way to check
 * whether the columns were even found.
 */
async function readResults(page) {
  const table = page.locator(selectors.resultsTable).first();
  await table.waitFor({ state: "attached", timeout: 15000 });

  return table.evaluate((tbl, columns) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    const headerCells = tbl.querySelectorAll("thead th").length
      ? Array.from(tbl.querySelectorAll("thead th"))
      : Array.from(tbl.querySelectorAll("tr:first-child th, tr:first-child td"));

    const headers = headerCells.map((c) => norm(c.innerText).toLowerCase());

    // Exact match, not "includes" — the real table has MULTIPLE headers
    // that share a substring (e.g. "Account status" vs the real "Status"
    // column; "Deposit Amount"/"Real Amount"/"Bonus Amount"/"Total Amount"
    // all contain "amount"). A partial match confirmed live to pick the
    // WRONG column ("Account status" instead of "Status", silently
    // breaking the Approved/Disapproved check this entire bot depends on).
    const colIndex = {};
    for (const [key, label] of Object.entries(columns)) {
      colIndex[key] = headers.findIndex((h) => h === label.toLowerCase());
    }

    const bodyRows = tbl.querySelectorAll("tbody tr").length
      ? Array.from(tbl.querySelectorAll("tbody tr"))
      : Array.from(tbl.querySelectorAll("tr")).slice(1);

    const rows = bodyRows
      .map((tr, index) => {
        const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
          norm(td.innerText)
        );
        const get = (k) => (colIndex[k] >= 0 ? cells[colIndex[k]] || "" : "");
        return {
          index,
          dpId: get("dpId"),
          reference: get("reference"),
          amountText: get("amount"),
          status: get("status"),
          cellCount: cells.length
        };
      })
      .filter((r) => r.cellCount > 1); // skip "No data" rows

    return { headers, colIndex, rows };
  }, selectors.columns);
}

async function clearDateRange(page, selector) {
  if (!selector) return;
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return;
  await loc.fill("").catch((e) => {
    console.log(`[SBO] Could not clear ${selector}: ${e.message}`);
  });
}

/*
 * Hard guard — read BOTH search boxes back right before clicking Search:
 * the active one must hold exactly what we just typed, the other must be
 * empty. Catches a fill() that silently didn't take (stale element, page
 * not fully settled right after navigation, etc.) instead of letting a
 * blank/wrong search quietly come back as "0 rows" and get misread as
 * "genuinely not found."
 */
async function verifySearchBoxState(page, activeSelector, expectedValue, otherSelector) {
  const activeVal = await page.locator(activeSelector).first().inputValue().catch(() => null);
  const otherVal = await page.locator(otherSelector).first().inputValue().catch(() => null);
  if (activeVal !== expectedValue) {
    throw new StoppedError(
      `Search box did not hold the value we just typed (expected "${expectedValue}", found "${activeVal}") — refusing to search on unverified input.`
    );
  }
  if (otherVal !== "") {
    throw new StoppedError(
      `The other search box was not empty (found "${otherVal}") before searching — a stale value there could narrow or corrupt the search.`
    );
  }
}

/*
 * Hard guard — after a search, confirm the column(s) THIS search depends
 * on were actually found in the table headers. A missing column would
 * otherwise make every row read that field as "", which looks exactly
 * like zero exact matches.
 */
function verifyColumnsFound(colIndex, requiredKeys) {
  const missing = requiredKeys.filter((k) => !(colIndex[k] >= 0));
  if (missing.length) {
    throw new StoppedError(`Results table is missing expected column(s): ${missing.join(", ")}.`);
  }
}

/*
 * field: "reference" | "dpId" — which box to search by (the other is
 * cleared first, per explicit instruction). step: 1 | 2 | 4, for [STEP n]
 * console logging only, matching the required flow's own numbering.
 */
async function search(step, field, value) {
  const page = await openDepositPage();

  await selectIfPossible(page, selectors.websiteTypeSelect, selectors.websiteTypeAllValue);
  await selectIfPossible(page, selectors.statusSelect, selectors.statusAllValue);

  // Created Time Range always cleared before searching — SBO pre-fills it
  // on every page load, which would otherwise silently exclude any
  // deposit outside that window (confirmed live, per explicit instruction).
  await clearDateRange(page, selectors.createdTimeRangeFromInput);
  await clearDateRange(page, selectors.createdTimeRangeToInput);

  const activeSelector = field === "reference" ? selectors.referenceInput : selectors.dpIdInput;
  const otherSelector = field === "reference" ? selectors.dpIdInput : selectors.referenceInput;

  await page.locator(otherSelector).fill("");
  await page.locator(activeSelector).fill(value);

  // Hard guard — confirmed state before searching.
  await verifySearchBoxState(page, activeSelector, value, otherSelector);

  await clickSearch(page);

  const { colIndex, rows } = await readResults(page);

  // Hard guard — the matched column and Status must both be present.
  verifyColumnsFound(colIndex, [field, "status"]);

  const withAmount = rows.map((r) => ({ ...r, amount: cleanAmount(r.amountText) }));

  // Exact match only — avoids "DP123" matching "DP1234".
  const target = value.toLowerCase();
  const matches = withAmount.filter((r) => (r[field] || "").toLowerCase() === target);

  console.log(`[STEP ${step}] Search ${field}=${value}: ${withAmount.length} rows, ${matches.length} exact`);
  return { page, matches };
}

function isApproved(row) {
  // Word match: "Disapproved" must NOT count as approved.
  const s = (row.status || "").toLowerCase();
  return selectors.approvedStatusTexts.some((t) =>
    new RegExp(`\\b${t.toLowerCase()}\\b`).test(s)
  );
}

/* ------------------------------------------------------------------ */
/* New Make up deposit (modal on the deposit page)                     */
/* ------------------------------------------------------------------ */

async function visibleTexts(scope, selector) {
  const loc = scope.locator(selector);
  const out = [];
  for (let i = 0; i < (await loc.count()); i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) {
      const t = (await el.innerText().catch(() => "")).trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/*
 * STEP 3 — fills the modal ONLY with Telegram data:
 *   Original Transaction ID = TG Transaction ID (DP ID)
 *   Reference No.           = TG RefCode
 *   Real Amount             = TG Amount
 * Clicks "Check", then decides pass/fail from whether the "Submit" button
 * is actually present AND enabled afterward (confirmed live — SBO shows a
 * "Check Pass" banner plus a real Submit button once Check succeeds) —
 * per explicit spec, NOT by text-matching an error banner whose exact
 * selector isn't confirmed. A "Reference No.: Duplicate" warning needs no
 * special-case handling here: per SBO's own Check Rule text it's allowed
 * to proceed, so Submit still appears in that case and this check passes
 * through it correctly on its own. Returns { passed, messages } — messages
 * is any visible popup/error text, collected best-effort for the reply's
 * "reason" field only, never used to decide pass/fail.
 */
async function makeupDeposit(page, req) {
  const messages = [];

  // Accept browser alert/confirm popups and keep their text as the "reason".
  const onDialog = (d) => {
    messages.push(d.message());
    console.log(`[STEP 3] Dialog: ${d.message()} -> accept`);
    d.accept().catch(() => {});
  };
  page.on("dialog", onDialog);

  try {
    // getByRole, not getByText — confirmed from the real DOM dump this is
    // an <input type="button" value="Make up deposit">, which has no text
    // NODE content for getByText to match (only buttons/links with real
    // child text work with getByText; an <input> button's visible label
    // lives in its value attribute instead). getByRole correctly resolves
    // an input button's accessible name from value, same as clickSearch()
    // above already relies on for the Search button.
    await page
      .getByRole("button", { name: selectors.makeupOpenButtonText, exact: false })
      .first()
      .click();

    const modal = page
      .locator(selectors.makeupModal)
      .filter({ hasText: selectors.makeupModalTitle })
      .first();
    await modal.waitFor({ state: "visible", timeout: 10000 });

    // "Single" tab (not Batch Deposit)
    const singleTab = modal.getByText("Single", { exact: true }).first();
    if (await singleTab.isVisible().catch(() => false)) await singleTab.click();

    await modal.getByPlaceholder(selectors.makeupDpIdPlaceholder).fill(req.tid);
    await modal.getByPlaceholder(selectors.makeupReferencePlaceholder).fill(req.reference);
    await modal.getByPlaceholder(selectors.makeupAmountPlaceholder).fill(String(req.amount));
    if (selectors.makeupRemark) {
      await modal.locator("textarea").first().fill(selectors.makeupRemark).catch(() => {});
    }

    await modal.getByRole("button", { name: selectors.makeupCheckButtonText, exact: true }).click();
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);

    messages.push(...(await visibleTexts(page, selectors.errorTextSelectors)));

    // Pass/fail signal: is Submit actually there and clickable? Scoped to
    // the modal (not the whole page) — the real SBO DOM has several OTHER
    // hidden "Submit" buttons belonging to unrelated forms elsewhere on
    // this same page (confirmed from the inspect-page.js dump), so an
    // unscoped page-wide lookup risks matching one of those instead.
    const submitBtn = modal.getByRole("button", { name: selectors.makeupSubmitButtonText, exact: true }).first();
    const submitVisible = (await submitBtn.count()) > 0 && (await submitBtn.isVisible().catch(() => false));
    const submitEnabled = submitVisible && (await submitBtn.isEnabled().catch(() => false));

    if (!submitEnabled) {
      console.log(`[STEP 3] Check did not pass — Submit button ${submitVisible ? "is disabled" : "did not appear"}.`);
      if (await modal.isVisible().catch(() => false)) {
        await page.keyboard.press("Escape").catch(() => {});
      }
      return { passed: false, messages: [...new Set(messages)] };
    }

    console.log("[STEP 3] Check passed — clicking Submit.");
    await submitBtn.click();
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    messages.push(...(await visibleTexts(page, selectors.errorTextSelectors)));

    // Close the modal if still open so the next search works.
    if (await modal.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape").catch(() => {});
    }

    return { passed: true, messages: [...new Set(messages)] };
  } finally {
    page.off("dialog", onDialog);
  }
}

/* ------------------------------------------------------------------ */
/* Main flow                                                           */
/* ------------------------------------------------------------------ */

/*
 * Returns { status, ...details }
 * status: ALREADY_APPROVED_REFERENCE | ALREADY_APPROVED_DP | DP_NOT_FOUND |
 *         DP_AMBIGUOUS | STOPPED | DRY_RUN | APPROVED | MAKEUP_FAILED
 *
 * Strict order per explicit spec — a step only begins after the previous
 * one finished correctly. Every hard guard (verifySearchBoxState,
 * verifyColumnsFound) throws StoppedError the instant something can't be
 * confirmed; caught once here and turned into a STOPPED result so the
 * flow NEVER falls through to the next step on unverified state.
 */
async function processApproval(req) {
  const missing = missingSelectors();
  if (missing.length) {
    throw new Error(`SBO selectors not configured: ${missing.join(", ")}`);
  }

  try {
    // STEP 1 — RefCode, ALWAYS first.
    const byRef = await search(1, "reference", req.reference);
    const approvedRef = byRef.matches.find(isApproved);
    if (approvedRef) {
      console.log(`[STEP 1] RefCode already Approved (DP ID ${approvedRef.dpId}) — stopping, no action taken.`);
      return { status: "ALREADY_APPROVED_REFERENCE", sboDpId: approvedRef.dpId };
    }
    console.log("[STEP 1] RefCode not already approved — continuing to STEP 2.");

    // STEP 2 — DP ID (TG Transaction ID).
    const byDp = await search(2, "dpId", req.tid);
    if (byDp.matches.length === 0) {
      console.log("[STEP 2] DP ID not found — stopping, no action taken.");
      return {
        status: "DP_NOT_FOUND",
        reason: "Transaction ID not found in SBO."
      };
    }
    if (byDp.matches.length > 1) {
      console.log(`[STEP 2] DP ID matched ${byDp.matches.length} rows — ambiguous, stopping.`);
      return { status: "DP_AMBIGUOUS", count: byDp.matches.length };
    }
    const dp = byDp.matches[0];
    if (isApproved(dp)) {
      console.log("[STEP 2] DP ID already Approved — stopping, no action taken.");
      return { status: "ALREADY_APPROVED_DP", sboDpId: dp.dpId, sboReference: dp.reference };
    }
    console.log("[STEP 2] DP ID found, not yet approved — continuing to STEP 3.");

    // For the log only — TG data is always what gets submitted.
    const sboInfo = { sboStatusBefore: dp.status, sboAmount: dp.amount };

    if (safety.dryRun) {
      console.log("[STEP 3] DRY_RUN — stopping before opening the make up form.");
      return { status: "DRY_RUN", ...sboInfo };
    }

    // STEP 3 — New Make up deposit with TG data ONLY.
    const { passed, messages } = await makeupDeposit(byDp.page, req);
    if (!passed) {
      return {
        status: "MAKEUP_FAILED",
        reason: messages.length ? messages.join(" | ") : "Check did not pass",
        ...sboInfo
      };
    }

    // STEP 4 — Verify: RefCode should now be on an approved deposit.
    const verify = await search(4, "reference", req.reference);
    const done = verify.matches.find(isApproved);
    if (done) {
      console.log(`[STEP 4] Verified Approved (DP ID ${done.dpId}).`);
      return { status: "APPROVED", sboDpId: done.dpId || req.tid, messages, ...sboInfo };
    }
    console.log("[STEP 4] RefCode still not Approved after Submit.");
    return {
      status: "MAKEUP_FAILED",
      reason: messages.length ? messages.join(" | ") : "SBO did not show the RefCode as approved after make up.",
      ...sboInfo
    };
  } catch (err) {
    if (err instanceof StoppedError) {
      console.log(`[STOPPED] ${err.reason}`);
      return { status: "STOPPED", reason: err.reason };
    }
    throw err;
  }
}

async function closeBrowser() {
  if (!activeContext) return;
  await activeContext.close().catch(() => {});
  activeContext = null;
}

module.exports = {
  openDepositPage,
  processApproval,
  closeBrowser
};
