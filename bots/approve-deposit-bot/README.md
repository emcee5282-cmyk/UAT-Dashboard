# Approve Deposit Bot

Send this in the Telegram group:

```
RefCode: 75GD3W3K
Amount: 200
Transaction ID: D1370154318
```

The bot first replies "⏳ Processing" with the RefCode, then the result:
✅ APPROVED · ⏭️ ALREADY APPROVED · ❌ NOT FOUND (with reason) · ❌ MAKE UP FAILED (with SBO's reason)

## Logic (absolute rule: TG data is used, never SBO data)

1. Search SBO by **RefCode**. If it's already approved, skip and reply with the DP ID.
2. Search SBO by **Transaction ID (DP ID)**. If it's not found, reply with the reason. If it's already approved, skip and reply with the DP ID.
3. **New Make up deposit** using TG data: Original Transaction ID = Transaction ID, Reference No. = RefCode, Real Amount = Amount. Click Check, then confirm.
4. Search the RefCode again. If it's approved, reply ✅ with the DP ID. If not, reply ❌ with SBO's error text.

Every request is written to `approvals.log`.

## Setup

1. `npm install` then `npx playwright install chromium`
2. `cp .env.example .env` and fill in the values
3. `npm run inspect`, then send `inspect-deposit.png` and `inspect-deposit.txt` back to me
4. `npm run inspect:makeup`: a browser opens. Open a deposit's Makeup form (don't submit). Send `inspect-makeup.png` and `.txt` back.
5. Fill the `TODO` selectors in `config.js` (or have me do it)
6. Test without Telegram: `node test-approve.js 75GD3W3K 200 D1370154318`
7. Add the bot to the group. In @BotFather, set **Group Privacy to OFF** so it can read normal messages.
8. Send `/chatid` in the group, then put that ID in `ALLOWED_CHAT_IDS`
9. `node bot.js` (or `pm2 start bot.js --name approve-bot`). Check `/status`.
