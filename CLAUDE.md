@AGENTS.md

# Operations Dashboard — Claude Context

## Project Info
- Location: C:\Users\ejboy\Desktop\dashbaord_project
- Live site: https://uat-dashboard.vercel.app
- Tech stack: Next.js 14, TypeScript, Tailwind CSS v4, Vercel, GitHub
- Font: Outfit (next/font/google) — NEVER use font-mono anywhere

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

## Design System (apply to ALL pages)
- Font: Outfit — never font-mono
- Table headers (th): text-[10px] font-semibold text-slate-500 dark:text-slate-400 text-center whitespace-nowrap px-3 py-2
- Table cells (td): text-[9px] text-center px-3 py-1 text-slate-700 dark:text-slate-300
- Zero/empty values: display "−" (U+2212 proper minus sign)
- No row borders (no border-b on tr)
- No zebra striping
- Sticky thead: sticky top-0 z-[50] bg-white dark:bg-[#2a2a2d]
- Page background: bg-[#f5f5f7] dark:bg-[#1c1c1e]
- Card background: bg-white dark:bg-[#2a2a2d]
- Border: border-[#e5e5e7] dark:border-[#3a3a3d]
- Page title: text-lg font-semibold text-slate-900 dark:text-white
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
- Leader filter: funnel icon on Leader header
- Wallet Status filter: funnel icon on Wallet Status header
- Column visibility: funnel icon after pagination
- Export Excel: download icon (SheetJS/xlsx)
- Sort arrows: always visible (ChevronUp/ChevronDown lucide-react)
- Default sort: Company Balance descending
- Skeleton loader: first load only, subsequent refreshes keep existing data

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
- Always use Outfit font, never font-mono
- Shared formatting in app/lib/format.ts
- Test locally before git push
- One concern at a time — do not combine unrelated changes
- Never expose phone numbers or sensitive agent data in UI
- Skeleton loader: match exact td padding (px-3 py-1) and row height of actual table

## Subagents (.claude/agents/)
- code-reader.md (haiku) — read-only, explains code
- code-auditor.md (sonnet) — security audit
- code-checker.md (sonnet) — type/bug check
- ui-reviewer.md (sonnet) — UI/UX audit

## Git Workflow
- Edit locally → test on localhost:3000 → git add . → git commit → git push
- Vercel auto-deploys after push (1-2 minutes)
