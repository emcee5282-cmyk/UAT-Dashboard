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

## API Routes (Google Sheets CSV proxy)
- /api/sheet → Dashboard data
- /api/opening → Opening Balance
- /api/agentbal → Agent Balance
- /api/stlm → Settlement + Top Up (shared)
- /api/sendmoney/opening → Send Money Opening Balance (reads the same "Opening AG" tab, but columns L:O — a separate ~9,983-row roster from Cashout's own agent list, not related row-by-row)

## Send Money (multi-product)
- Product switcher lives in the sidebar (indigo = Cashout, teal = Send Money), routes under /sendmoney/*, mapped to/from Cashout's legacy routes via app/lib/productRoutes.ts
- **/sendmoney/opening (app/sendmoney/opening/page.tsx) is the design reference** for every future Send Money page and for a possible future Cashout port — when building the next page, match its patterns (button system, filter panel, KPI cards, sticky header, chip hit-targets) rather than reinventing them. Fidelity to it matters more than speed.
- Dependencies: `googleapis` + the `google-auth-library` version override in package.json are committed and stable (resolved in commit c0c1bca) — not an open issue, no need to re-investigate.

## Data source gotchas
- The "Opening AG" tab is mirrored via IMPORTRANGE from another spreadsheet. Blank cells or `#REF!` values appearing in it are a known failure mode of that link (source range shifted, permission lapsed, etc.) — investigate as a possible sheet-side issue before assuming a parsing bug.

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
