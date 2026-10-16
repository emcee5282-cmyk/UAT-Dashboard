/*
 * Run one approval from the command line (no Telegram):
 *
 *   node test-approve.js <REFERENCE> <AMOUNT> <TID>
 *
 * Respects DRY_RUN in .env (default true = never clicks the final submit).
 */
require("dotenv").config();
const { processApproval, closeBrowser } = require("./sbo");
const { safety } = require("./config");

(async () => {
  const [reference, amount, tid] = process.argv.slice(2);
  if (!reference || !amount || !tid) {
    console.log("Usage: node test-approve.js <REFERENCE> <AMOUNT> <TID>");
    process.exit(1);
  }

  console.log(`Mode: ${safety.dryRun ? "DRY RUN" : "LIVE"}`);

  try {
    const result = await processApproval({ reference, amount: Number(amount), tid });
    console.log("RESULT:", JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("ERROR:", e.message);
  } finally {
    await closeBrowser();
  }
})();
