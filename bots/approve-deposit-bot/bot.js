require("dotenv").config();

const fs = require("fs");
const http = require("http");
const { Telegraf } = require("telegraf");
const { parseRequests, containsSecretKey } = require("./parser");
const { processApproval, closeBrowser } = require("./sbo");
const { safety, missingSelectors } = require("./config");

// Telegraf kills a handler (and crashes the process on the resulting
// unhandled rejection) if it doesn't resolve within handlerTimeout —
// 90s by default. The real SBO flow (login + search + makeup deposit,
// slower on first run) can easily take longer than that, so it's
// disabled here; our own queue/inFlight logic is what actually bounds
// how long a request can run.
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, { handlerTimeout: Infinity });

/* One SBO browser -> run jobs one at a time */
let queue = Promise.resolve();
function runInQueue(task) {
  const job = queue.then(task);
  queue = job.catch(() => {});
  return job;
}

/* Block the same TID / Reference being processed twice at once */
const inFlight = new Set();

/* Audit log: one JSON line per request */
function audit(entry) {
  fs.appendFileSync(
    "approvals.log",
    JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n"
  );
}

function fmtAmount(n) {
  return n === null || n === undefined ? "-" : Number(n).toLocaleString("en-US");
}

// Statuses that get posted to the webhook, per explicit instruction: the
// two "already done" outcomes (ALREADY_APPROVED_REFERENCE/_DP), the one
// fresh success (APPROVED), and the three genuine "something went wrong"
// cases (STOPPED, MAKEUP_FAILED, ERROR). Deliberately excludes
// DP_NOT_FOUND/DP_AMBIGUOUS (not a resolved outcome — needs manual look)
// and DRY_RUN/BUSY (not a makeup attempt at all).
const WEBHOOK_STATUSES = new Set([
  "APPROVED", "ALREADY_APPROVED_REFERENCE", "ALREADY_APPROVED_DP", "STOPPED", "MAKEUP_FAILED", "ERROR"
]);

const WEBHOOK_STATUS_LABEL = {
  APPROVED: "APPROVED",
  ALREADY_APPROVED_REFERENCE: "ALREADY APPROVED",
  ALREADY_APPROVED_DP: "ALREADY APPROVED",
  STOPPED: "STOPPED",
  MAKEUP_FAILED: "MAKE UP FAILED",
  ERROR: "ERROR"
};

// Structured per-field JSON (not the raw Telegram reply text) — so a
// receiving tool can select just one value (e.g. RefCode) without also
// grabbing its label, same as the manually-tested webhook format. "Remarks"
// is always the label, never "Reason", even for a stop/error — kept
// consistent across every status this sends for.
function buildWebhookPayload(req, result) {
  const base = {
    Status: WEBHOOK_STATUS_LABEL[result.status] || result.status,
    Brand: req.brand || "-",
    RefCode: req.reference,
    Amount: req.amount,
    "Transaction ID": req.tid
  };
  if (result.status === "APPROVED") {
    return { ...base, "Success DP ID": result.sboDpId, Remarks: "Make up deposit done." };
  }
  if (result.status === "ALREADY_APPROVED_REFERENCE") {
    return { ...base, "Success DP ID": result.sboDpId || "-", Remarks: "No action taken." };
  }
  if (result.status === "ALREADY_APPROVED_DP") {
    return { ...base, "Success DP ID": result.sboDpId || req.tid, Remarks: "No action taken." };
  }
  if (result.status === "ERROR") {
    return { ...base, Remarks: result.error || "Unknown error" };
  }
  // STOPPED / MAKEUP_FAILED
  return { ...base, Remarks: result.reason };
}

// Never blocks or fails the Telegram reply — logged and swallowed on error.
async function sendWebhook(req, result) {
  if (!safety.webhookUrl || !WEBHOOK_STATUSES.has(result.status)) return;
  const payload = buildWebhookPayload(req, result);
  try {
    const res = await fetch(safety.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    console.log(`[BOT] Webhook sent for ${req.tid} (${result.status}) -> HTTP ${res.status}`);
  } catch (error) {
    console.error(`[BOT] Webhook failed for ${req.tid}:`, error.message);
  }
}

// Shared by the Telegram handler and the HTTP endpoint below — runs the
// actual SBO approval, frees the inFlight dedup keys, audits, and fires
// the outbound webhook. Caller is responsible for the inFlight busy-check
// and reserving `keys` BEFORE calling this (so each channel can decide its
// own "already processing" messaging — a Telegram reply vs. an HTTP
// response — without this function needing to know which one it's for).
async function runApproval(req, keys, auditExtra) {
  let result;
  try {
    result = await runInQueue(() => processApproval(req));
  } catch (error) {
    console.error("[BOT] Approval error:", error);
    result = { status: "ERROR", error: error.message };
  } finally {
    keys.forEach((k) => inFlight.delete(k));
  }

  audit({ dryRun: safety.dryRun, request: req, result, ...auditExtra });
  console.log(`[BOT] ${req.tid} -> ${result.status}`);
  await sendWebhook(req, result);
  return result;
}

function buildReply(req, result) {
  const head =
    `Brand: ${req.brand || "-"}\n` +
    `RefCode: ${req.reference}\n` +
    `Amount: ${fmtAmount(req.amount)}\n` +
    `Transaction ID: ${req.tid}\n`;

  switch (result.status) {
    case "APPROVED":
      return `✅ APPROVED\n\n${head}\nSuccess ID: ${result.sboDpId}\n\nMake up deposit done.`;

    case "ALREADY_APPROVED_REFERENCE":
      return `⏭️ ALREADY APPROVED\n\n${head}\nSuccess DP ID: ${result.sboDpId || "-"}\n\n` +
        `This RefCode is already approved in SBO. No action taken.`;

    case "ALREADY_APPROVED_DP":
      return `⏭️ ALREADY APPROVED\n\n${head}\nSuccess DP ID: ${result.sboDpId || req.tid}\n\n` +
        `This DP ID is already approved in SBO. No action taken.`;

    case "DP_NOT_FOUND":
      return `❌ NOT FOUND\n\n${head}\nReason: ${result.reason}`;

    case "DP_AMBIGUOUS":
      return `⚠️ CHECK MANUALLY\n\n${head}\nReason: ${result.count} deposits match this Transaction ID. No action taken.`;

    case "MAKEUP_FAILED":
      return `❌ MAKE UP FAILED\n\n${head}\nReason: ${result.reason}`;

    case "STOPPED":
      return `⚠️ STOPPED — no action taken\n\n${head}\nReason: ${result.reason}`;

    case "DRY_RUN":
      return `🧪 TEST ONLY — would make up\n\n${head}\nSBO status: ${result.sboStatusBefore}`;

    case "BUSY":
      return `⏳ ALREADY PROCESSING\n\n${head}`;

    default:
      return `❌ ERROR\n\n${head}\nReason: ${result.error || "Unknown error"}\nPlease check manually.`;
  }
}

/* /chatid works in any chat so you can find the ID to put in ALLOWED_CHAT_IDS */
bot.command("chatid", (ctx) => ctx.reply(`Chat ID: ${ctx.chat.id}`));

/* Access control: only allowed chats — unless ALLOW_ALL_CHATS=true
 * (explicit opt-in, per instruction), which bypasses this entirely. */
bot.use((ctx, next) => {
  if (safety.allowAllChats) return next();

  const chatId = String(ctx.chat?.id || "");
  if (safety.allowedChatIds.length === 0) {
    console.log(`[BOT] ALLOWED_CHAT_IDS is empty. Ignoring chat ${chatId}.`);
    return;
  }
  if (!safety.allowedChatIds.includes(chatId)) {
    console.log(`[BOT] Ignored message from chat ${chatId}`);
    return;
  }
  return next();
});

bot.command("status", (ctx) =>
  ctx.reply(
    `Approve Deposit Bot online.${safety.dryRun ? "\n(TEST ONLY mode is on)" : ""}`
  )
);

bot.on("text", async (ctx) => {
  const requests = parseRequests(ctx.message.text);
  if (requests.length === 0) return; // not an approval message — stay quiet

  // Secret Key check — ONCE per message, before any request in it is
  // touched. A missing/wrong key means the WHOLE message is treated as
  // not a real request at all, per explicit instruction: no reply, no
  // processing, nothing echoed back. The key's own VALUE never appears in
  // this log line, or anywhere else — only whether it matched. Matched as
  // a plain substring anywhere in the message (see containsSecretKey),
  // not tied to a "Secret Key:" label — real messages had the label
  // mistyped or the value on its own line, which a label-based match
  // would wrongly reject.
  if (!safety.secretKey || !containsSecretKey(ctx.message.text, safety.secretKey)) {
    console.log(`[BOT] Rejected message — secret key mismatch (chat ${ctx.chat.id}).`);
    return;
  }

  for (const req of requests) {
    const replyOpts = { reply_parameters: { message_id: ctx.message.message_id } };
    const keys = [`tid:${req.tid}`, `ref:${req.reference}`];

    if (keys.some((k) => inFlight.has(k))) {
      await ctx.reply(buildReply(req, { status: "BUSY" }), replyOpts);
      continue;
    }

    keys.forEach((k) => inFlight.add(k));

    await ctx.reply(`⏳ Processing...\n\nBrand: ${req.brand || "-"}\nRefCode: ${req.reference}`, replyOpts);

    const result = await runApproval(req, keys, {
      source: "telegram",
      chatId: ctx.chat.id,
      from: ctx.from?.username || ctx.from?.id
    });

    await ctx.reply(buildReply(req, result), replyOpts);
  }
});

// HTTP endpoint — for a sender Telegram itself blocks from reaching this
// bot (another bot account posting in the same group; see safety.httpPort's
// own comment in config.js). Same text format + Secret Key as a Telegram
// message, POSTed as the raw body. Deliberately NOT JSON-only: the exact
// same multi-line template already in use just gets POSTed instead of sent
// as a Telegram message, so an existing Ops Support Team workflow only has
// to change its destination, not its message format.
let httpServer = null;
if (safety.httpPort) {
  httpServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/approve") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. POST to /approve." }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const requests = parseRequests(body);
        if (requests.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No valid RefCode/Amount/Transaction ID request found in the body." }));
          return;
        }

        // Secret Key check — identical rule to the Telegram path: once per
        // request body, missing/wrong key rejects the whole thing, key
        // value never echoed back.
        if (!safety.secretKey || !containsSecretKey(body, safety.secretKey)) {
          console.log("[BOT] Rejected HTTP request — secret key mismatch.");
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized." }));
          return;
        }

        const results = [];
        for (const r of requests) {
          const keys = [`tid:${r.tid}`, `ref:${r.reference}`];
          let result;
          if (keys.some((k) => inFlight.has(k))) {
            result = { status: "BUSY" };
          } else {
            keys.forEach((k) => inFlight.add(k));
            result = await runApproval(r, keys, { source: "http" });
          }
          results.push({ request: r, result });

          // Same human-visible audit trail a Telegram-originated request
          // gets — optional, skipped entirely if unset. Never blocks the
          // HTTP response on failure.
          if (safety.httpReplyChatId) {
            await bot.telegram.sendMessage(safety.httpReplyChatId, buildReply(r, result))
              .catch((error) => console.error("[BOT] Failed to relay HTTP result to Telegram:", error.message));
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results }));
      } catch (error) {
        console.error("[BOT] HTTP handler error:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error." }));
      }
    });
  });
  httpServer.listen(safety.httpPort, () => {
    console.log(`[BOT] HTTP endpoint listening on port ${safety.httpPort} — POST /approve`);
  });
}

bot.launch();

console.log("====================================");
console.log("Approve Deposit Bot started");
if (safety.dryRun) console.log("TEST ONLY mode (DRY_RUN=true)");
if (safety.allowAllChats) {
  console.log("WARNING: ALLOW_ALL_CHATS=true — ANY Telegram chat can trigger this bot, not just an allow-listed one.");
} else {
  console.log(`Allowed chats: ${safety.allowedChatIds.join(", ") || "NONE (bot will ignore everything)"}`);
}
console.log(
  safety.secretKey
    ? "Secret Key check: ON — every request must include the matching Secret Key."
    : "WARNING: SECURITY_CODE is not set — every request will be rejected until it is."
);
console.log(
  safety.httpPort
    ? `HTTP endpoint: ON — http://<this-server>:${safety.httpPort}/approve`
    : "HTTP endpoint: OFF (set HTTP_PORT in .env to enable)"
);
const missing = missingSelectors();
if (missing.length) console.log(`WARNING: SBO selectors not set: ${missing.join(", ")}`);
console.log("====================================");

async function shutdown(sig) {
  bot.stop(sig);
  if (httpServer) httpServer.close();
  await closeBrowser();
  process.exit(0);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
