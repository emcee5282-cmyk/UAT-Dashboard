@AGENTS.md

# Operations Dashboard — Claude Context

## Project Info
- Location: C:\Users\ejboy\Desktop\dashbaord_project
- Live site: https://uat-dashboard.vercel.app
- Tech stack: Next.js 14, TypeScript, Tailwind CSS v4, Vercel, GitHub
- Font: Inter (next/font/google) — NEVER use font-mono anywhere

## Pages
- / → Cash Out Wallets — app/page.tsx
- /summary → Opening Balance — app/summary/page.tsx
- /agentbal → Agent Balance — app/agentbal/page.tsx
- /stlm → Settlement — app/stlm/page.tsx
- /topup → Top Up — app/topup/page.tsx
- Sidebar: app/components/Sidebar.tsx
- Shared utils: app/lib/format.ts (rawVal, fmtNum, displayNum)
- Fetch error handling: app/lib/errors.ts (classifyFetchError, assertAllOk) + app/components/ConnectionErrorState.tsx — every page that fetches real data (all Cashout pages + every built-out /sendmoney/* page) uses these instead of a hand-rolled error message/box. Reuse them for any new fetching page rather than duplicating the old generic "Unable to load data" text.

## API Routes (Google Sheets CSV proxy)
- /api/sheet → Dashboard data. Scoped to `Dashboard Overview!A1:H6` (Cashout's own block only) — see the contamination note under Send Money Dashboard below for why this is scoped rather than a bare tab-name fetch.
- /api/opening → Opening Balance
- /api/agentbal → Agent Balance
- /api/stlm → **Legacy, superseded.** Old shared "Stlm Top Up" sheet. No longer used by any page (Settlement/Top Up/Agent Balance/Transfer Queue all moved to /api/agstlmtopup below) — kept only in case something still needs the raw legacy sheet; safe to remove once confirmed unused.
- /api/agstlmtopup → Cashout's Settlement + Top Up (reads "AG BD STLM + TOPUP", see note under Cashout Settlement/Top Up below)
- /api/sendmoney/opening → Send Money Opening Balance (reads the same "Opening AG" tab, but columns L:O — a separate ~9,983-row roster from Cashout's own agent list, not related row-by-row)
- /api/sendmoney/balances → Send Money Agent Balance (reads "SSP PS BalanceLimit", Send Money's own Balance Limit sheet — lines up column-for-column with Cashout's "SSP AG BalanceLimit" from index 4 onward, just without Cashout's leading "Reference" column)
- /api/sendmoney/stlmtopup → Send Money's Settlement + Top Up (reads "PS BD STLM + TOPUP", see note under Send Money below)
- /api/sendmoney/sheet → Send Money Dashboard data. Scoped to `Dashboard Overview!A8:H13` — same tab as Cashout's /api/sheet, just a different row block (see note below).

## Cashout Settlement + Top Up (app/stlm/page.tsx, app/topup/page.tsx, app/agentbal/page.tsx, app/transfer-queue/page.tsx, app/lib/transferQueueCount.ts)
- All five now read from "AG BD STLM + TOPUP" via /api/agstlmtopup, replacing the old shared "Stlm Top Up" sheet. Layout: cols B-F (indices 1-5) = Top Up (To Agent/Amount/Date/Wallet/Type, amounts stored **positive**, Type "BUNDLE TRANSFER"); cols H-L (indices 7-11) = Settlement (same field order, amounts stored **negative** — abs() before use, Type "INTERNAL TRANSFER"); cols Q-AA are a last-month archive and are never read. Confirmed by user: this column-position mapping (B-F=TopUp, H-L=Settlement) holds despite the Type labels being the opposite pairing from Send Money's equivalent sheet (where "BUNDLE TRANSFER" is the Settlement type) — the two sheets don't share a labeling convention, only Send Money's own literal wallet-name markers ("BD"/"PS") carried meaning; Cashout's doesn't.
- The sheet's own header row mislabels cols D/E as "Wallet"/"Date" — sampling confirmed the actual data order is Date then Wallet (matching Send Money's sheet), so the code reads column position by data pattern, not by trusting the header text.
- **Brand is no longer a column in this sheet** (removed by the user). Brand is resolved by cross-referencing the bare agent code against "SSP AG BalanceLimit" (via /api/agentbal, same `computeBrand`/`resolveBrand` Group-priority logic Cashout's own Agent Balance page already uses) — not by mapping a gateway label like the old sheet's col M, and not by parsing a suffix off the wallet name.
- "To Agent" values sometimes carry a trailing "-<brand>" suffix (e.g. "KONAN001-M1"), sometimes not (e.g. "YUJI024") — `stripBrandSuffix()` removes it so the bare code matches Opening AG's / SSP AG BalanceLimit's own always-bare agent names, used both as the display "Agent Name" and as the brand-lookup/leader-lookup key. The suffix itself, when present, is not trusted as the brand — it's stripped and brand is re-resolved fresh from SSP AG BalanceLimit for consistency.

## Send Money (multi-product)
- Product switcher lives in the sidebar (indigo = Cashout, teal = Send Money), routes under /sendmoney/*, mapped to/from Cashout's legacy routes via app/lib/productRoutes.ts
- **/sendmoney/opening (app/sendmoney/opening/page.tsx) is the design reference** for every future Send Money page — when building the next page, match its patterns rather than reinventing them. Fidelity to it matters more than speed. Current pattern (supersedes the earlier icon-tile/flat-sortable version): a literal structural duplicate of Cashout's own Opening Balance page (app/summary/page.tsx) — legacy compact table style (10px uppercase headers, 11px cells, center-aligned), inline "Accounts" count pill + search box in the toolbar (no KPI card row), a single "Filter" button that controls column visibility only (Check All + one checkbox per column), per-column dropdown filters embedded directly in the Brand/Leader header cells (chevron/count badge, not a side panel), only Agent Name/Opening Balance/Security Deposit are sortable by clicking the header — Brand/Leader are filter-only, matching Cashout's own quirk; page-counter pagination ("X / Y" + Previous/Next, not range-style); 50 rows/page (matches Cashout's rowsPerPage constant); responsive mobile card list below sm breakpoint; sticky opaque table header; skeleton re-shown on every refresh, not just first load (page-scoped override of the app-wide "first load only" rule below); Export respects column visibility. Only deviations from a byte-for-byte Cashout copy: teal accent via the --product-accent CSS variable (not hardcoded indigo) and the 600ms minimum-visible-spin floor on Refresh (interaction polish, not layout). Nullable Opening Balance/Security Deposit (blank ≠ 0) is Send Money's own data model and was not changed by this UI duplication.
- Dependencies: `googleapis` + the `google-auth-library` version override in package.json are committed and stable (resolved in commit c0c1bca) — not an open issue, no need to re-investigate.
- **/api/sendmoney/stlmtopup** fetches "PS BD STLM + TOPUP" — Send Money's own dedicated Settlement + Top Up sheet, replacing the earlier approach of reusing Cashout's shared "Stlm Top Up" sheet cols A-G. Layout: cols B-F (indices 1-5) = Top Up (To Agent/Amount/Date/Wallet/TYPE, amounts stored **positive**); cols H-L (indices 7-11) = Settlement (same field order, amounts stored **negative** — abs() before use); cols Q-AA are a last-month archive block and are never read. Confirmed by direct sampling: Top Up rows are PS-named wallets with TYPE "INTERNAL TRANSFER" (e.g. "N-B4PS2-GYRO023-NG"); Settlement rows are BD-named wallets with TYPE "BUNDLE TRANSFER" (e.g. "D-B2BD-DELTA073-NG") — same wallets/amounts previously (and incorrectly) sourced as "Settlement" from the old shared sheet's cols A-G. Used by /sendmoney/balances, /sendmoney/settlement, and /sendmoney/transfer-queue.
- **/sendmoney/balances (app/sendmoney/balances/page.tsx)** duplicates Cashout's Agent Balance page (app/agentbal/page.tsx) the same way Opening Balance duplicates Cashout's Opening page — same columns/layout/filters/buttons, teal accent instead of indigo. Data sources: master roster + SDP/Opening/Leader from "Opening AG" cols L-O (same sheet /api/opening already fetches for Cashout, index shift +11), wallet activity (Total DP/WD, Balance, Login, Account Status, Group/Bank) from "SSP PS BalanceLimit" via /api/sendmoney/balances, and Settlement + Top Up totals from /api/sendmoney/stlmtopup (see above). Adaptations from Cashout's version (not literal copies): no SDP VS Balance leader-exclusion list (Cashout's 19-name list doesn't apply to Send Money's own roster — add one here if a Send Money exclusion policy is ever defined); Type is read directly off the wallet name's own suffix ("N-T1PS2-NAVY040-NG" -> "NG"), not the Balance Limit sheet's Bank field — every Send Money shop is solo (one wallet per network, max 2 wallets per shop), so the row's own name already carries its type, and every suffix in the roster is confirmed to be one of NG/RK/UP/BK; brand codes include Send Money's own 'SH' brand. Same cutoff-date filtering as Cashout (col I of "Opening AG" instead of col G) applied to both Settlement and Top Up so entries already folded into the last Opening Balance reset aren't double-counted — this can make either total legitimately show 0 on a day with no post-cutoff entries in that block, which is correct, not a bug.
- **/sendmoney/settlement (app/sendmoney/settlement/page.tsx)** duplicates Cashout's Settlement page (app/stlm/page.tsx) — same flat transaction-listing layout (Brand/Agent Name/Wallet/Amount/Remarks/Date), sourced from /api/sendmoney/stlmtopup cols H-L (no cutoff-date filtering here — this is a transaction log, not a running balance, so unlike the Agent Balance page it lists every row). Brand is derived from the wallet name itself (segment after first "-", e.g. "D-B2BD-DELTA073-NG" -> "B2"), not Cashout's own col-M gateway-label mapping — reuses the SH -> "Sharing" display-label pattern from the Agent Balance page.
- **/sendmoney/topup (app/sendmoney/topup/page.tsx)** duplicates Cashout's Top Up page (app/topup/page.tsx) — same columns/layout (Brand/Leader/Agent Name/Wallet/Amount/Type/Date), sourced from /api/sendmoney/stlmtopup cols B-F. Brand is derived from the wallet name itself (segment after first "-"), same pattern as the Settlement page — not Cashout's own last-hyphen-segment convention, which would incorrectly return the NG/RK/UP/BK type suffix for Send Money's wallet names. Leader lookup reuses the same "Opening AG" cols L-O roster (index shift +11) as the other Send Money pages.
- **/sendmoney (app/sendmoney/page.tsx)** duplicates Cashout's Dashboard (app/page.tsx) — same KPI cards / Wallet Summary / Top Performer Wallet / High Volume Agents layout, teal accent. Data source: the user added a Send Money block to the *same* "Dashboard Overview" tab Cashout's own dashboard reads, at rows 8-13 (header + BKASH/NAGAD/ROCKET/UPAY/Total) — fetched via the new, explicitly-scoped /api/sendmoney/sheet (`A8:H13`). **This required also re-scoping the existing /api/sheet to `A1:H6`**: an unscoped `fetchRange('Dashboard Overview')` (the pre-existing code) would otherwise return both products' blocks concatenated, and Cashout's own dashboard would silently double up its Wallet Summary table with Send Money's rows too (same lowercase wallet-name key, e.g. "Bkash" vs "BKASH", so the DP/WD patch step would even overwrite one with the other's numbers) — caught and fixed before it could reach production, not a reported bug. Wallet-type grouping (for patching Total DP/WD/Bundle Transfer/Settlement with live computed data over the sheet's manually-seeded values) is done by the wallet name's own suffix (NG/RK/UP/BK, same convention as /sendmoney/balances), not a literal wallet-type text column. Actual Balance and the wallet-level Opening Balance seed are read as-is from the sheet (manually tracked real balances, same as Cashout — no live equivalent exists to compute them from agent-level data). **Bundle Transfer Trend** (replaces the earlier empty CashGo placeholder) is a stacked bar chart of daily Settlement totals per wallet, last 7/30 days, sourced from the same "PS BD STLM + TOPUP" sheet /api/sendmoney/stlmtopup already fetches — but reading cols H-L (idx 7-11, this month's Settlement rows) **unioned with** cols W-AA (idx 22-26, last month's archived Settlement rows, same 5-field layout — To Agent/Amount/Date/Wallet/TYPE — shifted +15; cols Q-U hold the equivalent Top Up archive and are not used here). Only rows whose TYPE field is exactly "BUNDLE TRANSFER" are counted (confirmed this is the only value ever seen in the Settlement blocks, but the check is enforced per explicit instruction, not assumed). Amounts are stored negative in the sheet and shown as abs(). Grouped by the row's own literal "Wallet" field (already spelled "NAGAD"/"ROCKET"/"UPAY", not derived from a suffix) — only 3 wallets exist in this data (no BKASH), consistent with Bkash being excluded/Coming-Soon everywhere else on this page.
  - Redesigned (per user-supplied mockup image) away from Cashout's own CashGo Trend look: stacked bars (nagad/rocket/upay, teal/violet/amber) instead of grouped bars, a static legend row instead of click-to-show toggle buttons, and **Today is embedded as the chart's own last bar** (highlighted with an accent-colored outline + accent-colored axis label) rather than shown in a separate summary strip above the chart. Each period is N-1 historical days ending yesterday plus Today (6+1=7 for the week view, 29+1=30 for the month view) — not N full days ending yesterday.
  - Week mode: every bar gets a value label, no Y-axis. Month mode: only the peak day and Today are labeled (rest revealed via tooltip on hover), and a minimal Y-axis is shown. X-axis uses `interval="preserveStartEnd"` in month mode specifically so the last tick (Today) can't be skipped by numeric-interval parity on a 30-item array.
  - **Recharts gotcha, hard-won**: a stacked `<Bar>`'s `LabelList` (even with a custom `content` function) is never invoked for a day where that specific series' own value is 0 — there's no rectangle to anchor a label to. Worse, when that happens, the `index` prop recharts passes to `content` is renumbered to only count that series' own non-zero entries, so `bundleChartData[index]` silently returns the *wrong day* once a series has any zero-value gaps (confirmed by direct prop logging: the "upay" series' internal index topped out around 21 instead of 29 on a 30-day window). This recharts version's LabelList props also don't include `payload` as a fallback. The fix: read `value` (from `dataKey="total"`, always correct) and match it back against `bundleChartData` by value instead of trusting `index`; and attach the same `LabelList` to *all three* stacked bars, each one only rendering when it's the topmost non-zero segment for that day (`upay > 0 ? upay : rocket > 0 ? rocket : nagad`) — guaranteeing the label always lands on a segment that actually has a rect to attach to. **Wallet Summary on this page only has 6 columns, not 7** — Settlement is deliberately omitted (it reads the same "BUNDLE TRANSFER" TYPE source as Bundle Transfer, so showing both was a duplicate; Bundle Transfer was kept since it matches the chart name). The underlying `stlm` field is still computed and still feeds Running Balance's math — only the rendered column was removed. Bundle Transfer's own cell shows its native sign (`fmtCell(row.bdTransferIn, true)`), kept neutral-colored (no semantic color) intentionally. Cashout's own Wallet Summary (app/page.tsx) is untouched and keeps both Bundle Transfer and Settlement — Settlement is a genuinely distinct value there.
- **/sendmoney/transfer-queue (app/sendmoney/transfer-queue/page.tsx)** duplicates Cashout's Transfer Queue page (app/transfer-queue/page.tsx) — same columns/layout/filters/export, teal accent. Data sources identical to /sendmoney/balances (Opening AG cols L-O, "SSP PS BalanceLimit", /api/sendmoney/stlmtopup with cutoff filtering). Ruleset is genuinely different from Cashout's, confirmed with user against a real rule table screenshot: no DAY variant, no separate "Low Balance"/"Discrepancy" group names — every brand (M1, M2, B1-B5, K1, J1, T1) has exactly two possible correct groups, "{Brand} 24/7 DP + WD" and "{Brand} 24/7 WD Only". Three independent triggers all point to WD Only (checked first, in this order): SDP VS Balance > 50,000, Discrepancy > 10,000, Company Balance > 45,000; Company Balance < 20,000 is the only DP + WD trigger. 'SH' (Sharing) has no rule and is never queued. SDP VS Balance here is a raw, unfloored Company Balance − SDP gap (`computeSdpVsBalanceRaw`), deliberately different from the Agent Balance page's own SDP VS Balance column (which floors to 0 below 30,000 for display) — the Transfer Queue's own 50,000 gate needs the real gap, not a pre-floored one. Verified against real data: 8,671 of 9,983 Send Money agents (87%) have no recorded SDP; confirmed with user that these still fall back to using their full Company Balance as the gap (same fallback Cashout uses), gated at the corrected 50,000/10,000 thresholds (an earlier misreading of the source image as 8,000/8,000 was caught because it flagged half the entire roster — see git history for the correction). Shops whose wallet name carries a "BD" segment (e.g. "D-M2BD-DELTA063-NG") are excluded from this page entirely, per user instruction — note this means Transfer Queue itself never surfaces the "BD" wallets that /sendmoney/settlement's data comes from; that exclusion is Transfer-Queue-specific, not a data-source restriction.

## Data source gotchas
- The "Opening AG" tab is mirrored via IMPORTRANGE from another spreadsheet. Blank cells or `#REF!` values appearing in it are a known failure mode of that link (source range shifted, permission lapsed, etc.) — investigate as a possible sheet-side issue before assuming a parsing bug.
- **`rawVal()` never returns an empty string — blank cells become `'-'`.** Any roster filter written as `row.agentName && row.agentName !== 'OLD'` is a latent bug: `'-'` is truthy, so it silently passes and blank rows are counted. This stayed dormant for a long time because "Opening AG" hadn't grown past Cashout's own roster length; once Send Money's own roster (cols L-O) grew longer than Cashout's (cols A-D), the sheet's total row count exceeded 3,452 and every trailing blank-Cashout/filled-Send-Money row leaked through, inflating Cashout's own "Accounts" count to the Send Money roster's own count (9,972) even though Cashout's real roster is ~3,452. Fixed everywhere this filter pattern appeared (`app/agentbal/page.tsx`, `app/page.tsx`, `app/summary/page.tsx`, `app/transfer-queue/page.tsx`, `app/lib/transferQueueCount.ts`, `app/lib/sendMoneyOpening.ts`, `app/sendmoney/balances/page.tsx`, `app/sendmoney/transfer-queue/page.tsx`) by adding `&& row.agentName !== '-'`. If a *new* page ever copies this filter again, copy the 3-part version, not the 2-part one.

## Design System v2 (current standard — applies going forward; migrate legacy pages opportunistically)
- Font: Inter — never font-mono
- Design tokens (defined in app/globals.css `:root`/`.dark`, mapped in tailwind.config.js): `--background`, `--foreground`, `--border`, `--muted`, `--muted-foreground` → use as `bg-background`, `text-foreground`, `border-border`, `bg-muted`/`text-muted-foreground`
- KPI cards: container `flex gap-4 mb-6`; card `bg-white rounded-xl border border-border p-5 flex-1 min-w-0`; title `text-xs text-muted-foreground font-medium mb-1`; big value `text-[28px] font-bold text-foreground mb-1`; change text `text-[11px] font-medium` + `text-rose-600`/`text-emerald-600`/`text-foreground` (negative/positive/neutral)
- Table outer container: `bg-white rounded-xl border border-border overflow-hidden`
- Table toolbar: `px-4 py-3 border-b border-border bg-muted/20 flex items-center justify-between`
- Single "Filter" button (funnel icon + label) replaces per-column filter icons — opens one dropdown with all filter sections
- Table header row: `border-b border-border bg-muted/10`; header cell: `px-4 py-3 text-xs font-semibold text-muted-foreground whitespace-nowrap` + alignment (`text-left`/`text-right`/`text-center`)
- Table body row: `border-b border-border last:border-0 hover:bg-muted/10 transition-colors`; alternate rows may add `bg-muted/5`
- Table body cell: `px-4 py-3 text-xs text-foreground whitespace-nowrap` + alignment; bold values add `font-medium`
- Status badges: `inline-flex items-center px-2.5 py-1 rounded-md text-[11px] font-medium border` + semantic bg/text/border color pair (e.g. amber for "WD Only", emerald for healthy/active states, rose for issues, slate for inactive/no-record)
- Zero/empty values: still display "−" (U+2212 proper minus sign) — unchanged by the visual redesign
- Page title: text-lg font-bold text-foreground
- Header search/refresh controls: text-sm, border border-border rounded-lg

### Legacy style (still used by pages not yet migrated: /, /summary, /stlm, /topup)
- Table headers (th): text-[10px] font-semibold text-slate-500 dark:text-slate-400 text-center whitespace-nowrap px-3 py-2
- Table cells (td): text-[9px] text-center px-3 py-1 text-slate-700 dark:text-slate-300
- No row borders (no border-b on tr), no zebra striping
- Sticky thead: sticky top-0 z-[50] bg-white dark:bg-[#2a2a2d]
- Page background: bg-[#f5f5f7] dark:bg-[#1c1c1e]
- Card background: bg-white dark:bg-[#2a2a2d]
- Border: border-[#e5e5e7] dark:border-[#3a3a3d]
- Header controls: text-[11px], compact (px-2 py-1.5)

## Column Colors
- Company Balance: font-bold, negative = text-rose-600 dark:text-rose-400, positive = neutral bold
- Wallet Name / Agent Name: font-bold text-slate-900 dark:text-white
- Total DP: text-emerald-600 dark:text-emerald-400
- Total WD: text-rose-600 dark:text-rose-400
- Top Up: text-teal-600 dark:text-teal-400
- Settlement: text-orange-500 dark:text-orange-400
- All others: neutral text-slate-700 dark:text-slate-300
- Leader: neutral (no indigo)

## Agent Balance Page (/agentbal)
### Column Order
Leader, Wallet Name, SDP, Opening, Total DP, Total WD, Top Up, Settlement, Company Balance, Balance Inside, Agent Withdrawal, SDP VS Balance, Wallet Status

### Features
- Master list: Opening sheet (~3,486 agents)
- Pagination: 50 rows per page
- Single "Filter" button (funnel icon + label) in table toolbar — opens one dropdown with Leader, Brand, Wallet Status, and Type filter sections (no per-column filter icons)
- Column visibility: separate funnel icon next to pagination
- Export Excel: download icon (SheetJS/xlsx) — respects column visibility
- Sort arrows: always visible (ChevronUp/ChevronDown lucide-react) on sortable columns only
- Default sort: Company Balance descending
- Skeleton loader: first load only, subsequent refreshes keep existing data
- Uses Design System v2 (see above) — first page migrated off the legacy table style

### Computed Columns
- Company Balance = Opening + Total DP + Top Up - Total WD - Settlement
- Balance Inside = sum of Balance (cols[8]) where Login (cols[15]) = "Yes"
- Agent Withdrawal = Company Balance - Balance Inside
- SDP VS Balance = Company Balance - SDP (show only if positive and > 30,000, use Math.abs, excluded leaders show "−")
- Wallet Status = determined from Account Status (cols[2]) priority rules

### SDP VS Balance Excluded Leaders
AFF JAR, AIMAN, ALADDIN, JISAN, MIR, MR LEE, MUNIM, NIHJUM, NURNOBY, ONEMEN, OSMAN, MOTIN, ROSE, SAM, XYZ, SHAKIL, SHARIF, SVEN, TANVIR, ZUBAIR

### Wallet Status Priority Rules
1. Has "DP + WD" → "DP + WD"
2. Has both "DP Only" AND "WD Only" → "DP + WD"
3. Has "DP Only" → "DP Only"
4. Has "WD Only" → "WD Only"
5. Has "Top Up" (any variant) → "Top Up Acc."
6. Has "Wallet With Issue" → "Wallet With Issue"
7. Has "Disconnected" or "X Group" → "Disconnected"
8. Has "Check Account Problem" → "Account Problem"
9. Zero matching rows in Agent Balance → "No Record"
10. All others → "Disconnected"

## STLM Page Column Order
Brand | Agent Name | Wallet | Amount | Remarks | Date

## Top Up Page Column Order
Brand | Agent Name | Wallet | Amount | Type | Date

## Opening Balance Column Order
Leader | Agent Name | Opening Bal. | SDP

## Important Rules (ALWAYS FOLLOW)
- Show summary before applying changes
- Never change data logic when fixing UI
- Never add auto-refresh (fetch on open + manual refresh only)
- Always use Inter font, never font-mono
- Shared formatting in app/lib/format.ts
- Test locally before git push
- One concern at a time — do not combine unrelated changes
- Never expose phone numbers or sensitive agent data in UI
- Skeleton loader: match exact td padding (px-3 py-1) and row height of actual table
- Phased work (plan → go → implement → verify → one commit): each new phase's plan must open by stating current `git status` (working-tree clean or not) and any unanswered questions carried over from the previous phase — don't let them go unaddressed silently
- Verification reports must state HOW each item was tested (exact steps/method: what was clicked, what was checked, what tool), not just a checkmark — a checkmark alone doesn't prove the interaction was exercised end-to-end. (Learned the hard way: "chips remove individually" and the Refresh button were both marked verified from checks that only confirmed the control entered a transient state — chip rendered, spinner appeared — not that the state-changing action actually completed and took effect.)

## Subagents (.claude/agents/)
- ONLY use subagents for major tasks (security audit, deep bug investigation)
- For regular edits and fixes — NO subagents, direct instruction only
- code-reader.md (haiku) — use ONLY when need to understand unfamiliar code
- code-auditor.md (sonnet) — use ONLY before major deployments
- code-checker.md (sonnet) — use ONLY after major refactors
- ui-reviewer.md (sonnet) — use ONLY for full UI audit sessions
- DEFAULT: skip all subagents for routine fixes, UI changes, and column updates

## Git Workflow
- Edit locally → test on localhost:3000 → git add . → git commit → git push
- Vercel auto-deploys after push (1-2 minutes)
