/*
 * Run: node inspect-page.js
 *
 * Logs into SBO, opens the deposit page, and saves:
 *   - inspect-deposit.png      (screenshot)
 *   - inspect-deposit.txt      (all inputs, selects, buttons, tables + headers)
 *
 * Send both files back so the TODO selectors in config.js can be filled.
 *
 * Makeup form: npm run inspect:makeup
 *   Opens a visible browser and waits 60s so you can search a deposit and
 *   open its Makeup form by hand (don't submit), then dumps that form too
 *   (inspect-makeup.png / .txt).
 */
require("dotenv").config();
const fs = require("fs");
const { openDepositPage, closeBrowser } = require("./sbo");

async function dump(page, name) {
  await page.screenshot({ path: `inspect-${name}.png`, fullPage: true });

  const info = await page.evaluate(() => {
    const describe = (el) => {
      const label =
        (el.id && document.querySelector(`label[for="${el.id}"]`)?.innerText) ||
        el.closest("td")?.previousElementSibling?.innerText ||
        el.placeholder ||
        "";
      return {
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        id: el.id || "",
        name: el.name || "",
        label: (label || "").trim().slice(0, 60),
        visible: !!(el.offsetWidth || el.offsetHeight),
        text: (el.innerText || el.value || "").trim().slice(0, 60)
      };
    };

    const inputs = Array.from(document.querySelectorAll("input, textarea")).map(describe);
    const selects = Array.from(document.querySelectorAll("select")).map((s) => ({
      ...describe(s),
      options: Array.from(s.options).map((o) => `${o.value} = ${o.text.trim()}`).slice(0, 40)
    }));
    const buttons = Array.from(
      document.querySelectorAll("button, input[type=button], input[type=submit], a.btn, a[onclick]")
    ).map(describe);
    const tables = Array.from(document.querySelectorAll("table")).map((t, i) => ({
      index: i,
      id: t.id,
      className: t.className,
      headers: Array.from(t.querySelectorAll("th")).map((th) => th.innerText.trim()),
      rows: t.querySelectorAll("tbody tr").length
    }));

    return { url: location.href, inputs, selects, buttons, tables };
  });

  fs.writeFileSync(`inspect-${name}.txt`, JSON.stringify(info, null, 2));
  console.log(`Saved inspect-${name}.png and inspect-${name}.txt`);
}

(async () => {
  try {
    const page = await openDepositPage();
    await dump(page, "deposit");

    if (process.argv[2] === "--makeup") {
      console.log("You have 60s: search a deposit and open its Makeup form in the browser window...");
      await page.waitForTimeout(60000);
      await dump(page, "makeup");
    }
  } catch (e) {
    console.error(e);
  } finally {
    await closeBrowser();
  }
})();
