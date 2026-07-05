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
- Fetch errors: app/lib/errors.ts (classifyFetchError, assertAllOk) + app/components/ConnectionErrorState.tsx — every fetching page (all Cashout + built-out /sendmoney/*) uses these instead of a hand-rolled error box. Reuse for any new fetching page.

## API Routes (Google Sheets CSV proxy)
- /api/sheet → Dashboard data, scoped `Dashboard Overview!A1:H6` (Cashout's block only — unscoped fetch would blend in Send Money's rows, see /sendmoney note)
- /api/opening → Opening Balance
- /api/agentbal → Agent Balance
- /api/stlm → **Legacy, superseded** by /api/agstlmtopup. Safe to remove once confirmed unused.
- /api/agstlmtopup → Cashout's Settlement + Top Up ("AG BD STLM + TOPUP")
- /api/sendmoney/opening → reads "Opening AG" cols L:O — separate ~9,983-row roster, not related row-by-row to Cashout's
- /api/sendmoney/balances → reads "SSP PS BalanceLimit", lines up column-for-column with Cashout's "SSP AG BalanceLimit" from index 4 on (no leading "Reference" col)
- /api/sendmoney/stlmtopup → "PS BD STLM + TOPUP"
- /api/sendmoney/sheet → Send Money Dashboard, scoped `Dashboard Overview!A8:H13` (same tab as /api/sheet, different row block)

## Cashout Settlement + Top Up (app/stlm, app/topup, app/agentbal, app/transfer-queue, app/lib/transferQueueCount.ts)
- All read "AG BD STLM + TOPUP" via /api/agstlmtopup. Cols B-F = Top Up (To Agent/Amount/Date/Wallet/Type, **positive**, Type "BUNDLE TRANSFER"); cols H-L = Settlement (same fields, **negative** — abs() before use, Type "INTERNAL TRANSFER"); cols Q-AA = last-month archive, unused. Type labels are the opposite pairing from Send Money's equivalent sheet — the two sheets share no labeling convention.
- Header row mislabels cols D/E as "Wallet"/"Date" — actual order is Date then Wallet; code reads by data pattern, not header text.
- Brand is not a column here (removed by user) — resolved by cross-referencing the bare agent code against "SSP AG BalanceLimit" (same computeBrand/resolveBrand logic as Agent Balance page).
- "To Agent" sometimes carries a trailing "-<brand>" suffix (e.g. "KONAN001-M1") — `stripBrandSuffix()` strips it for display/lookup keys; the suffix itself is never trusted as brand, brand is always re-resolved from SSP AG BalanceLimit.

## Send Money (multi-product)
- Product switcher in sidebar (indigo=Cashout, teal=Send Money), routes under /sendmoney/*, mapped via app/lib/productRoutes.ts.
- **/sendmoney/opening is the design reference** for every future Send Money page — match its patterns, don't reinvent. Structural duplicate of Cashout's Opening page: legacy compact table style, Accounts-count pill + search (no KPI cards), single Filter button = column visibility only, per-column dropdown filters in Brand/Leader headers, only Agent Name/Opening Bal/SDP sortable, page-counter pagination, 50 rows/page, mobile card list, sticky header, skeleton re-shown every refresh (page-scoped override of the app-wide first-load-only rule), Export respects visibility. Deviations: teal accent via --product-accent, 600ms min-spin on Refresh. Nullable Opening Bal/SDP (blank≠0) is Send Money's own data model.
- googleapis + google-auth-library version override in package.json: stable (c0c1bca), not an open issue.
- /api/sendmoney/stlmtopup reads "PS BD STLM + TOPUP": cols B-F = Top Up (positive, PS wallets, "INTERNAL TRANSFER"); cols H-L = Settlement (negative→abs(), BD wallets, "BUNDLE TRANSFER"); cols Q-AA archive, unused. Feeds /balances, /settlement, /transfer-queue.
- **/sendmoney/balances** duplicates Agent Balance. Sources: "Opening AG" L-O (roster/SDP/Opening/Leader), "SSP PS BalanceLimit" (wallet activity), stlmtopup (Settlement+TopUp). Diffs from Cashout: no SDP-exclusion list; Type read from wallet-name suffix not Bank field (every shop solo; suffixes always NG/RK/UP/BK); brand includes 'SH'. Cutoff-date filtering (col I) same as Cashout — a total can legitimately show 0, not a bug.
- **/sendmoney/settlement** duplicates Settlement page. Sourced from stlmtopup cols H-L, no cutoff filtering (transaction log, lists every row). Brand = wallet-name segment after first "-" (not col-M mapping).
- **/sendmoney/topup** duplicates Top Up page. Sourced from stlmtopup cols B-F. Brand = same wallet-name-segment convention (not Cashout's last-hyphen-segment, which would return the NG/RK/UP/BK suffix instead). Leader from "Opening AG" L-O.
- **/sendmoney (dashboard)** duplicates Cashout Dashboard. Data: Send Money block on the same "Dashboard Overview" tab, rows 8-13, via /api/sendmoney/sheet (`A8:H13`) — required re-scoping /api/sheet to `A1:H6` to stop Send Money's rows contaminating Cashout's Wallet Summary (same lowercase wallet-name keys). Wallet-type grouping by wallet-suffix. Actual Balance/Opening seed read as-is (manual, no live equivalent). **Bundle Transfer Trend is a standalone implementation, NOT the shared TrendChart component** — briefly wired to it, reverted per explicit user scope correction; don't re-link without being told. Sourced from stlmtopup cols H-L unioned with W-AA archive, filtered to TYPE="BUNDLE TRANSFER", grouped by literal Wallet field (nagad/rocket/upay only, no bkash). Stacked bars, Today-as-last-bar, static legend. Recharts gotcha: LabelList never fires for a series' zero-value day and renumbers `index` when it happens — match by `value` instead, attach to every bar and let each check if it's the topmost non-zero segment. Wallet Summary has 6 cols not 7 (Settlement omitted as a duplicate of Bundle Transfer's own source; `stlm` field still feeds Running Balance's math). Bundle Transfer shows native sign, neutral color.
- **/sendmoney/transfer-queue** duplicates Transfer Queue. Same sources as /balances. Ruleset genuinely differs: no DAY variant; every brand has exactly 2 groups ("{Brand} 24/7 DP+WD" / "{Brand} 24/7 WD Only"). WD Only triggers (checked in order): SDP VS Balance>50k, Discrepancy>10k, Company Balance>45k. DP+WD trigger: Company Balance<20k. 'SH' never queued. SDP VS Balance here is raw/unfloored (`computeSdpVsBalanceRaw`), unlike Agent Balance page's floored version. 87% of agents (8,671/9,983) have no SDP and fall back to full Company Balance as the gap. Shops with "BD" in the wallet name are excluded entirely (Transfer-Queue-specific only).

## Shared TrendChart component (app/components/TrendChart.tsx)
- Used ONLY by Cashout's CashGo Trend (app/page.tsx). Briefly shared with Send Money's Bundle Transfer Trend, reverted (scope over-reach) — don't re-link without explicit instruction. All colors via `var(--product-accent)`, no hardcoded hex. Root-level `components/` is dead code (orphaned `Sidebar.tsx`) — use `app/components/*`.
- Owns its own `period` (week/month) and per-series visibility state. Props: `title`, `seriesDefs` (stack/ramp order), `weekData` (6 history + Today), `monthData` (29 history + Today).
- Color ramp: single `fill="var(--product-accent)"`, `fillOpacity` stepped by series index (`[1, 0.6, 0.35]`). Today's segments get an accent `stroke` + extra `×0.55` opacity cut.
- Week: no Y-axis, every bar labeled. Month: 3-tick Y-axis (0/mid/max), only peak-day + Today labeled, dashed avg line (over historical points only, excludes partial Today). X-axis `interval="preserveStartEnd"` in month mode so Today's tick can't be skipped.
- The **last-declared series renders as the topmost stack segment** (bottom = base/touches axis), confirmed by real tooltip data — a 7x-larger first series still rendered as the larger BASE, not on top. Radius and label-host detection must target the last VISIBLE series, not the first.
- Toggling a chip is a real filter: it zeroes that series' value in the data (not remove the `<Bar>` — unmounting/remounting reorders recharts' internal stack registration, a real bug hit and fixed). Dot signal (solid/hollow) reflects today's data independent of toggle state.
- Today strip: `Today {total}` + `▲/▼ {pct}% vs 30-day avg` only (hidden if avg is 0). Per-series amounts live in the tooltip only (`—` for zero).
- Recharts gotcha: a stacked Bar's `LabelList` never fires for a zero-value day and renumbers `index` when it happens (no `payload` fallback in this version) — match the label's `value` against the data array instead of trusting `index`.

## Data source gotchas
- "Opening AG" is mirrored via IMPORTRANGE — blank cells/`#REF!` are a known link failure mode (range shift, permission lapse); check sheet-side before assuming a parsing bug.
- **`rawVal()` never returns `''` — blanks become `'-'`, which is truthy.** A roster filter like `row.agentName && row.agentName !== 'OLD'` silently passes blank rows. Fixed everywhere via `&& row.agentName !== '-'` (app/agentbal, app/page, app/summary, app/transfer-queue, app/lib/transferQueueCount.ts, app/lib/sendMoneyOpening.ts, app/sendmoney/balances, app/sendmoney/transfer-queue). Copy the 3-part version if this filter is copied again.

## Design System v2 (current standard; migrate legacy pages opportunistically)
- Font: Inter — never font-mono
- Tokens (app/globals.css `:root`/`.dark`, mapped in tailwind.config.js): `--background`, `--foreground`, `--border`, `--muted`, `--muted-foreground`
- KPI cards: `flex gap-4 mb-6`; card `bg-white rounded-xl border border-border p-5 flex-1 min-w-0`; title `text-xs text-muted-foreground font-medium mb-1`; value `text-[28px] font-bold text-foreground mb-1`; change `text-[11px] font-medium` + rose/emerald/foreground
- Table container: `bg-white rounded-xl border border-border overflow-hidden`; toolbar `px-4 py-3 border-b border-border bg-muted/20 flex items-center justify-between`
- Single "Filter" button (funnel + label) replaces per-column icons
- Header row: `border-b border-border bg-muted/10`; header cell `px-4 py-3 text-xs font-semibold text-muted-foreground whitespace-nowrap` + alignment
- Body row: `border-b border-border last:border-0 hover:bg-muted/10 transition-colors`; body cell `px-4 py-3 text-xs text-foreground whitespace-nowrap`
- Status badges: `inline-flex items-center px-2.5 py-1 rounded-md text-[11px] font-medium border` + semantic color pair
- Zero/empty: "−" (U+2212). Page title: `text-lg font-bold text-foreground`. Header controls: `text-sm border border-border rounded-lg`

- Legacy style (still used by /, /summary, /stlm, /topup): th `text-[10px] font-semibold text-slate-500 dark:text-slate-400 text-center whitespace-nowrap px-3 py-2`; td `text-[9px] text-center px-3 py-1 text-slate-700 dark:text-slate-300`; no row borders/zebra; sticky thead `sticky top-0 z-[50] bg-white dark:bg-[#2a2a2d]`; page bg `bg-[#f5f5f7] dark:bg-[#1c1c1e]`; card `bg-white dark:bg-[#2a2a2d]`; border `border-[#e5e5e7] dark:border-[#3a3a3d]`; header controls `text-[11px]`, compact `px-2 py-1.5`

## Column Colors & Orders
- Company Balance: bold, negative=rose, positive=neutral bold. Wallet/Agent Name: bold slate-900/white. Total DP: emerald. Total WD: rose. Top Up: teal. Settlement: orange. Leader: neutral. All others: neutral slate-700/300.
- STLM: Brand | Agent Name | Wallet | Amount | Remarks | Date. Top Up: Brand | Agent Name | Wallet | Amount | Type | Date. Opening Balance: Leader | Agent Name | Opening Bal. | SDP

## Agent Balance Page (/agentbal)
- Columns: Leader, Wallet Name, SDP, Opening, Total DP, Total WD, Top Up, Settlement, Company Balance, Balance Inside, Agent Withdrawal, SDP VS Balance, Wallet Status
- Master list: Opening sheet (~3,486 agents). 50 rows/page. Single Filter button (Leader/Brand/Wallet Status/Type). Separate column-visibility funnel. Export respects visibility. Sort arrows always visible on sortable columns. Default sort: Company Balance desc. Skeleton: first load only. Uses Design System v2.
- Computed: Company Balance = Opening + Total DP + Top Up − Total WD − Settlement. Balance Inside = Σ Balance where Login="Yes". Agent Withdrawal = Company Balance − Balance Inside. SDP VS Balance = Company Balance − SDP (only if positive & >30,000, abs, excluded leaders show "−"). Wallet Status from Account Status priority rules below.
- SDP VS Balance excluded leaders: AFF JAR, AIMAN, ALADDIN, JISAN, MIR, MR LEE, MUNIM, NIHJUM, NURNOBY, ONEMEN, OSMAN, MOTIN, ROSE, SAM, XYZ, SHAKIL, SHARIF, SVEN, TANVIR, ZUBAIR
- Wallet Status priority: DP+WD > (DP Only & WD Only)→DP+WD > DP Only > WD Only > Top Up (any variant)→"Top Up Acc." > Wallet With Issue > Disconnected/X Group→Disconnected > Check Account Problem→Account Problem > zero rows→No Record > else→Disconnected

## Important Rules (ALWAYS FOLLOW)
- Show summary before applying changes. Never change data logic when fixing UI. Never add auto-refresh (fetch on open + manual refresh only). Always Inter, never font-mono. Shared formatting in app/lib/format.ts. Test locally before git push. One concern at a time. Never expose phone numbers or sensitive agent data. Skeleton loader must match exact td padding (px-3 py-1) and row height.
- Phased work (plan → go → implement → verify → one commit): each new phase's plan opens with current `git status` and any unanswered questions carried from the previous phase.
- Verification reports must state HOW each item was tested (exact steps/tool) — a checkmark alone doesn't prove the interaction was exercised end-to-end (learned the hard way: chip-removal and Refresh were marked verified from transient-state checks only).
- **Token discipline**: for visual/chart debugging, dump geometry/DOM as JSON via evaluate scripts instead of screenshots; screenshots only as a last resort, tightly clipped. Don't re-read whole files at the start of a request — use Grep/offset reads; edits persist.

## Subagents (.claude/agents/) & Git Workflow
- Subagents ONLY for major tasks (security audit, deep bug investigation) — NOT for regular edits/fixes. code-reader (haiku): unfamiliar code only. code-auditor (sonnet): before major deployments only. code-checker (sonnet): after major refactors only. ui-reviewer (sonnet): full UI audit sessions only. DEFAULT: skip all subagents for routine fixes, UI changes, column updates.
- Git: edit locally → test on localhost:3000 → git add . → git commit → git push. Vercel auto-deploys after push (1-2 minutes).
