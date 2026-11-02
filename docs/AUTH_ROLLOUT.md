# Rollout checklist — user accounts & roles (branch `feature/auth-roles`)

The moment the new code is deployed, **every page needs a login**. So the
order is: back up → prepare the database → create accounts → deploy → check.
Pick a quiet window (e.g. after the 9 PM Telegram send). Allow about 1 hour.

---

## Before rollout day

1. ~~Fix the password-library build issue.~~ **Done** — passwords now use
   `hash-wasm` (WebAssembly argon2id), so the Windows-built package runs on the
   Linux VPS. Existing argon2id hashes still verify.
2. **Merge `feature/auth-roles`** into the branch you deploy from
   (`deploy.sh` builds whatever is checked out). Careful: pushing a branch to
   GitHub also creates a Vercel preview build.
3. **Prepare the member list** (spreadsheet): username, display name, role,
   team, and — for Leader accounts — their leader name exactly as in the
   dashboard.
4. **Check the VPS settings file** (`/root/UAT-Dashboard-release/release/.env`):
   - `DATABASE_URL` points at the DigitalOcean database.
   - The site is opened over **https** (login cookies are "Secure" in
     production and won't work over plain `http://`).
   - `SYNC_SECRET`, `DAILY_TXN_ROLLOVER_SECRET`, `CRON_SECRET` are still set —
     the nightly jobs keep using these, they don't need a login.

---

## Rollout day

### Step 1 — Back up (do not skip)
1. **Database:** in the DigitalOcean control panel, check the latest automatic
   backup exists. Then also take your own copy from your PC (read-only):
   ```
   C:\pgsql16\bin\pg_dump.exe --dbname="<production DATABASE_URL>" -Fc -f prod-before-auth-YYYYMMDD.pgc
   ```
   Check the file is roughly 10+ MB.
2. **App:** copy the current live release on the VPS:
   ```
   ssh root@159.89.169.210 "cp -a /root/UAT-Dashboard-release/release /root/UAT-Dashboard-release/release-before-auth"
   ```

### Step 2 — Add the new database tables
Safe to do while the old site is running — it only **adds** columns/tables;
the current live site ignores them.
1. On your PC, create a file `.env.prodmigrate` containing only:
   `DATABASE_URL="<production DATABASE_URL>"`
2. Run:
   ```
   npx tsx --env-file=.env.prodmigrate scripts/_apply-auth-security-migration.ts
   ```
   Expect: `0044_add_auth_security.sql: applied (13 statements)`,
   `0045_add_roles.sql: applied (8 statements)` and
   `0046_add_user_avatar.sql: applied (1 statements)`. Running it twice is harmless.
3. **Do not** use `npm run db:migrate` — production's migration history is out
   of step and it would try to re-run old migrations.

### Step 3 — Lock down the old accounts
```
npx tsx --env-file=.env.prodmigrate scripts/_apply-auth-account-hardening.ts --deactivate=leader.test,leader.other,leader.javed,leader.zerotest
```
This deactivates `staff.test` and the 4 leader test accounts, and makes the
old shared `admin` change its password at next login.

### Step 4 — Create your own Admin
```
npx tsx --env-file=.env.prodmigrate scripts/create-user.ts --role=admin
```
It asks for username and password in the terminal (hidden). It prints the
database host first — make sure it says the DigitalOcean host. Use your own
name, not `admin`; deactivate the shared `admin` later from the Users page.

### Step 5 — System (scheduler) account — not needed on production
Production's nightly jobs (sync, 12 AM rollover, 2 AM stagnant Excel) use the
secret keys from Step "Before rollout" #4, not a login — nothing to create.
The `system` account is only for `scripts/local-scheduler.ts` on a PC. If you
ever need it:
```
npx tsx --env-file=.env.local scripts/create-user.ts --role=system
```
then add to that PC's `.env.local`:
```
SCHEDULER_USERNAME=<the username>
SCHEDULER_PASSWORD=<the password>
```

### Step 6 — Create every member's account (before switching on)
Use your PC's copy of the app, temporarily pointed at production:
1. In `.env.local`, comment out the local `DATABASE_URL` line and uncomment the
   DigitalOcean one. Restart `npm run dev`.
2. Open `http://localhost:3000`, log in with the Admin from Step 4.
3. **Users → Add user** for each person on your list. Their first-login
   password is their **username**; they must change it before any page opens.
4. ⚠️ While pointed at production, **don't press any "Send to Telegram"
   button** — production's database holds the real Telegram bot tokens.
5. Switch `.env.local` back to the local database and restart `npm run dev`.

### Step 7 — Deploy (this switches the login on)
From Git Bash on your PC:
```
MSYS_NO_PATHCONV=1 VPS_HOST=159.89.169.210 VPS_USER=root VPS_PATH=/root/UAT-Dashboard-release npm run deploy:package
ssh root@159.89.169.210 "pm2 restart dashboard"
```

### Step 8 — Check it straight away
1. Open the live site → you should see the login page.
2. Log in with your Admin → Dashboard loads; Users page lists everyone.
3. Log in as one OPS and one Viewer account (private/incognito window) →
   OPS sees edit/upload buttons, Viewer doesn't.
4. `ssh root@159.89.169.210 "pm2 logs dashboard --lines 50"` → no errors
   mentioning `argon2`, `sessions` or `roles`.

### Step 9 — Hand out credentials
Send each person their username **privately** (first-login password = the
username). They must set their own password at first login (10+ characters,
letters and numbers, not the username).

### Step 10 — Next morning
- The 12 AM rollover and the sync ran (Daily Entry shows today's carry-over).
- The 2 AM Stagnant Balances Excel arrived in Telegram.

---

## If something breaks — roll back

**Site down / nobody can log in:** (the pre-auth code is also tagged in git as
`pre-auth-rollout`, for rebuilding the old site if the VPS copy is lost)
```
ssh root@159.89.169.210
pm2 stop dashboard
mv /root/UAT-Dashboard-release/release /root/UAT-Dashboard-release/release-failed
mv /root/UAT-Dashboard-release/release-before-auth /root/UAT-Dashboard-release/release
pm2 start dashboard
```
The old site is back in under a minute. **Leave the database as it is** — the
old code ignores the new tables and columns, and the accounts you created will
be ready for the next attempt.

**You locked yourself out:** wait 15 minutes, or have another Admin unlock you
on the Users page, or create a fresh Admin with Step 4's command.

**Database problem (very unlikely):** restoring the Step 1 backup would also
erase any data entered after the backup was taken — only do this as a last
resort, and ask first.
