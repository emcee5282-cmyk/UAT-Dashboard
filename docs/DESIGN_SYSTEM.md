# Design System

Reference manual for how this dashboard is structured, which pieces are shared, which are intentionally independent, and how to extend it without drifting from the existing architecture. This document describes the system as it exists in the codebase today — every convention below was verified against actual component source and rendered output, not written from a template.

---

## 1. Design Philosophy

- **Enterprise-first.** Built for staff running the same handful of workflows every day, not for first-time visitors. Density and speed of scanning matter more than approachability.
- **Consistency over customization.** Every operational page looks and behaves the same way — search in the same place, filters in the same place, pagination in the same place — so muscle memory transfers between pages instead of resetting on each one.
- **Composition over configuration.** Shared components (`Toolbar`, `DataTable`, `PageHeader`, ...) are layout shells that accept children/render-props, not components with a growing prop surface for every page's quirks. A page composes what it needs from primitives rather than asking a shared component to grow a new flag.
- **Predictable interactions.** Refresh always lives in the same slot. Empty states always follow the same icon/title/description shape. Sorting always shows the same chevron affordance. A user who's learned one page has learned the interaction model for all of them.
- **High information density.** Compact type sizes (`text-[10px]`–`text-[13px]`), tight row padding, and no wasted vertical space — this is a working tool for people who need many rows visible at once, not a marketing surface.
- **Accessibility.** `aria-label`/`aria-current`/`role="row"`/`role="columnheader"` are applied throughout the shared components; focus-visible outlines are explicit rather than relying on browser defaults.
- **Maintainability.** Duplication is tolerated only where it reflects a genuine business-logic difference (see [§8](#8-architecture-principles)). Where two pages do the exact same thing, that thing is centralized once — in a shared component, a shared lib function, or a design token — specifically so a future change doesn't require hunting down every copy.

---

## 2. Page Templates

There are exactly two approved page shapes. A new page should fit one of these, not invent a third, unless it's a genuinely different kind of page (in which case, treat that as a real architectural decision, not a shortcut).

### Operational Page

```
PageHeader
   ↓
Toolbar
   ↓
DataTable
   ↓
TableFooter
```

A page whose job is showing, filtering, sorting, and paginating a list of records — search box, column-visibility/filter dropdown, sortable columns, Export, and a stable pagination footer.

**Used by:** Settlement, Balance, Opening Balance, Transfer Queue, Top Up (Cashout's five). These are also the reference implementations for this template — new operational pages should match their structure, not reinvent it.

> Send Money's five equivalent pages (`/sendmoney/balances`, `/sendmoney/opening`, `/sendmoney/settlement`, `/sendmoney/topup`, `/sendmoney/transfer-queue`) are the same *kind* of page but still run on the pre-Design-System-v2 shell (`FloatingHeader` + bespoke toolbar markup) — that migration was deliberately paused (see [§9](#9-future-roadmap)) to prioritize reducing duplicated business logic first. They are not a second template; they're the same template, not yet migrated.

### Analytics Page

```
PageHeader
   ↓
Analytics Sections
 (KPI Cards, Charts, Summary Tables, Ranking Lists)
```

A page whose job is presenting an at-a-glance summary, not browsing/filtering a record list. No search, no filter, no pagination — sections render fully, always.

**Used by:** Balance Overview (`/`), SSP Overview (`/balance-overview`).

---

## 3. Shared Components

| Component | Purpose | Use it when | Don't use it when |
|---|---|---|---|
| **Sidebar** | App-wide navigation dock (desktop icon rail + expandable labeled panel, mobile slide-in drawer). Owns the Cashout/Send Money product-aware routing and the Transfer Queue badge counts. | Never instantiated by a page directly — `AppShell` owns it. | N/A — singleton, rendered once at the app root. |
| **AppShell** | Reserves layout space for the Sidebar (`margin-left` synced to `--sidebar-width`) and wraps page content in `PageTransition`. | Wraps the whole app in the root layout. | Never per-page. |
| **PageHeader** | Page identity only — icon, title, optional description, optional centered content (e.g. `ProductSwitchTabs`), optional right-side actions. Deliberately has no idea what search/filter/export/refresh are. | Every page, both templates. | If a page needs the *old* auto-wired refresh button baked in — that's `FloatingHeader` (legacy, not yet fully retired — see below). |
| **Toolbar** | Pure 3-slot (`Toolbar.Left` / `Toolbar.Center` / `Toolbar.Right`) flex layout shell, `justify-between`. Owns none of the content — search box, filter dropdown, Refresh, Export are all composed in by the page. | Operational pages, above the table. | Analytics pages — if a page has no search/filter/export/refresh, it needs no Toolbar at all (see [§7](#7-analytics-standards)). |
| **DataTable** | Outer card shell (border/radius/overflow) plus two composable pieces: `DataTable.ScrollArea` (tracks scroll position, exposes `isScrolled` via render-prop) and `DataTable.StickyHeader` (background/border/scroll-shadow only — knows nothing about columns). | Operational pages wrapping a native `<table>` or CSS Grid table. | Analytics summary tables (Wallet Summary, SSP Line tables, etc.) — those are small, fully-rendered, and don't need scroll-shadow/sticky-header machinery. |
| **TableFooter** | Record-count text (left) + numbered pager (right), fixed height regardless of whether pagination actually renders (`totalPages > 1`), so the footer never resizes based on the current page count. | Any operational page with pagination. | Analytics pages (no pagination exists there). |
| **EmptyState** | Generic icon/title/description/optional-action block for a table body with zero matching rows. Owns no branching logic — the caller decides the copy and whether an action makes sense for *this* empty reason (no-search-match vs. genuinely-empty-queue read differently). | Every operational page's zero-row state, both desktop and mobile. | Anywhere a genuinely different message is needed that isn't "no rows" (that's `ConnectionErrorState`, a separate component for fetch failures). |
| **LoadingSkeleton** | *Not an extracted component.* Every page still renders its own inline `animate-pulse` skeleton rows/cards, matching that page's own td padding and column count exactly. | — | This was deliberately not extracted during the component-extraction phase — each page's skeleton shape is coupled tightly enough to its own column layout that a generic wrapper would need per-page configuration, which the project's "composition over configuration" principle argues against. If a second, genuinely identical skeleton shape appears, extracting it becomes a legitimate next step — see the token-extraction rule in [§5](#5-design-tokens): don't build it ahead of a second consumer. |

`FloatingHeader` still exists and is still in use on every page not yet migrated to `PageHeader` — it's the predecessor `PageHeader` was extracted from, kept alive because retiring it is a page-by-page migration, not a one-time change.

---

## 4. Component Rules

- **Prefer composition over configuration.** If a page needs something a shared component doesn't do, compose it as a child/sibling rather than adding a prop to the shared component to do it.
- **Do not extend a shared component's API to satisfy one page.** A prop added for a single consumer is a page-specific concern leaking into shared code. If two-plus pages independently need the same capability, that's a legitimate reason to extend it — not before.
- **Shared components change only for cross-page improvements**, a genuine bug, or an accessibility issue — never as a side effect of building a specific page's feature.
- **Business logic stays out of UI components.** `Toolbar`/`DataTable`/`TableFooter`/`PageHeader`/`EmptyState` know nothing about brand codes, wallet statuses, or calculation formulas — that logic lives in `app/lib/*` or the page itself. A shared UI component that starts importing page-specific business logic is a sign it's grown beyond its role.
- **One shared-component change per phase, justified in the open.** Historically, the only shared-component changes made during the whole migration rollout were `Toolbar`'s and `DataTable`'s `className` prop (full-override on `Toolbar`, append-only on `DataTable` — chosen per-component based on whether an override needs to replace conflicting sizing or just add non-conflicting spacing) — both justified as multi-page-beneficial before being made, not page-specific patches.

---

## 5. Design Tokens

Location: `app/design-system/`. Each token is a plain exported string (a literal Tailwind class or class fragment) — no runtime CSS-in-JS, no indirection beyond "import the constant instead of retyping the string." Tailwind's own build-time scanner picks up the literal class text wherever it appears, including inside these `.ts` files, so importing a token produces exactly the same generated CSS as the inline string it replaced.

| Module | Contains |
|---|---|
| `shadows.ts` | `FLOATING_HEADER_SHELL_CLASS` (the `PageHeader`/`FloatingHeader` header pill), `TABLE_STICKY_HEADER_SHADOW_CLASS` (the scroll-triggered sticky-header shadow fragment). |
| `table.ts` | `TABLE_STICKY_HEADER_CLASS` + `TABLE_HEADER_CELL_CLASS` (shared by every native-table operational page's `<thead>`), `TOOLBAR_ROW_CLASS` / `TOOLBAR_LEFT_CLASS` / `TOOLBAR_RIGHT_CLASS` (the Toolbar density override used by the four pages built directly against the shared `Toolbar`). |
| `spacing.ts` | `PAGE_MAIN_PADDING_CLASS` (the `<main>` content-padding wrapper, shared by every page), `KPI_CARD_CLASS` (Balance's summary-card container). |
| `transitions.ts` | `SIDEBAR_SYNC_DURATION_CLASS` — the 220ms duration shared by `Sidebar`'s width animation and `AppShell`'s margin animation; these two **must** stay in lockstep or the layout visibly desyncs during collapse/expand. |
| `tokens.ts` | Barrel re-export of the above four modules, for convenience imports. |

**The governing rule: only extract values that are genuinely shared across two or more real consumers, verified by diffing the actual strings — not by "these look similar."** A value used exactly once stays inline in the component/page that owns it. Tailwind's own utility scale (`rounded-xl`, `shadow-lg`, `duration-150`, etc.) is *already* a design-token layer — wrapping an unmodified Tailwind utility in a same-named JS constant adds a layer of indirection without adding a new single source of truth, and is explicitly not done here.

---

## 6. Operational Table Standards

Measured against the actual rendered pages (Balance, at 1440px viewport), not assumed:

- **Row height ≈ 27px** (`px-3 py-1.5` + `text-[11px]` content) — a deliberately compact, high-density row.
- **Header row height ≈ 36.5px.**
- **Footer height: fixed 60px**, regardless of whether pagination controls actually render — `TableFooter` reserves the space either way so the page doesn't resize under the user.
- **Sticky header** on every native-table page — background/border always present, a scroll-shadow (`shadow-[0_1px_3px_rgba(0,0,0,0.06)]` light / a stronger one dark) only once real content is scrolled underneath it.
- **Uniform center alignment** — every column (wallet/shop name, amounts, dates, actions) renders `text-center`. This is a deliberate, consistent choice across every operational page in the app, not per-column customization — there is no right-aligned-numbers convention here.
- **Contextual EmptyState copy.** The title/description is chosen per page and per cause — e.g. Balance/Opening's "No matching accounts found — try adjusting your search or filters" reads differently from Transfer Queue's "No accounts need transfer — queue is clear," because an empty queue is the *good* state there, not a failed search.
- **Loading skeleton mirrors the final layout exactly** — same `td` padding, same column count, same row height — so the loading state doesn't visually jump when real data arrives.

---

## 7. Analytics Standards

- **No Toolbar unless the page truly needs one.** Balance Overview and SSP Overview have zero search/filter/export controls anywhere — they don't get a Toolbar just for consistency's sake. Refresh, on these pages, lives in `PageHeader`'s own `actions` slot instead (the documented exception to "Refresh belongs in Toolbar").
- **Summary tables are not `DataTable`.** The Wallet Summary / SSP Line tables are small, fully-rendered (no pagination), often carry a `tfoot` totals row, and don't need scroll-shadow or sticky-header behavior — wrapping them in `DataTable` would add machinery they don't use.
- **Charts remain page-specific.** The shared `TrendChart` component is used only by Cashout's CashGo Trend. Send Money's Bundle Transfer Trend is a deliberately standalone implementation (stacked bars, static legend, its own `LabelList` value-matching workaround, wallet-suffix grouping) — it was briefly wired to `TrendChart` and reverted as scope over-reach. Don't re-link it without being told to.
- **Ranking lists remain page-specific.** "Top Performer Wallet" / "High Volume Agents" (and Send Money's equivalents) are bespoke per page — there's no shared "ranked list" component, and none is needed until a second, genuinely identical shape shows up.

---

## 8. Architecture Principles

### Shared

| What | Where | Why it's shared |
|---|---|---|
| **Balance calculation engine** | `app/lib/balanceEngine.ts` | Company Balance, Balance Inside, Agent Withdrawal, SDP VS Balance, and the wallet-status priority chain were confirmed **algorithmically identical** between Cashout's Balance page and Send Money's — the only differences were a couple of injectable config values (excluded-SDP-leader list, brand code list). Duplicating an identical formula across two ~1,700-line files was a real maintenance risk: a bug fix in one wouldn't propagate to the other. |
| **Upload Excel workflow** | `app/components/UploadExcelModal.tsx` | The ~350-line dropzone/validation-preview/error-report/import-log workflow was near-verbatim duplicated between Cashout's and Send Money's Opening pages, differing only in accent color, API endpoint, and which shop-name-extraction callback to use. |
| **Shared formatting/parsing utilities** | `app/lib/format.ts`, `app/lib/csv.ts`, `app/lib/businessDate.ts` | `parseCsvLines`, `parseAmount`, `isToday`, `fmt`/`fmtAbbrev`/`fmtCell`/`clean` were confirmed byte-identical across every page that had its own copy — pure functions with zero product-specific behavior. |

### Remain Independent

| What | Why it stays separate |
|---|---|
| **Settlement engine** | Cashout and Send Money's brand-resolution logic are two genuinely different algorithms (cross-reference lookup against a second sheet vs. a wallet-name-segment parse), and the two products' sheets use the *opposite* Type-label pairing ("BUNDLE TRANSFER" means Top Up on one sheet and Settlement on the other). Not a parameterization of one shared idea — a real divergence. |
| **Transfer Queue engine** | Cashout's queue-classification core is a table-driven rule engine with a DAY/24-7 axis; Send Money's is a flat, brand-gated if-chain with no DAY concept, different trigger thresholds, and an extra wallet-name exclusion Cashout doesn't have. Confirmed at only ~15–20% logic overlap at the actual classification core (vs. ~90% at the surrounding UI/aggregation layer, which *is* shareable). |
| **Top Up brand resolution** | Cashout resolves brand via a suffix-then-cross-reference-fallback hybrid; Send Money resolves it via a fixed wallet-name segment position, with no cross-reference step at all. Different mechanics, not different config. |
| **Dashboard trend charts** | Send Money's Bundle Transfer Trend is intentionally a standalone implementation (see [§7](#7-analytics-standards)) — a deliberate, previously-reverted decision, not an oversight. |

The general rule: two pieces of code get shared when diffing them shows the *algorithm* is the same and only *configuration* differs. When the underlying rules are genuinely different, sharing them would mean building one system that has to know about both products' business rules — which is a worse outcome than two independent, each individually simple, implementations.

---

## 9. Future Roadmap

**Enterprise Table V2** — the next planned milestone. Informational only; nothing below is implemented yet, and this section is not an authorization to start building it.

Planned capabilities:
- Column Visibility (beyond the current single Filter-button approach)
- Saved Views
- Advanced Filters
- Density Modes
- Bulk Selection
- Bulk Actions
- Keyboard Shortcuts

Send Money's five operational pages (Balance/Opening/Settlement/Top Up/Transfer Queue) have since been migrated from `FloatingHeader` + bespoke markup onto the same `PageHeader`/`Toolbar`/`DataTable`/`TableFooter`/`EmptyState` shell Cashout's equivalents use — the pause mentioned in earlier drafts of this document is over. Enterprise Table V2 work (below) begins on Settlement only; it is not yet rolled out to any other page.

---

## 10. Enterprise Table V2 — Column Visibility

**Status:** implemented on Settlement (`app/stlm/page.tsx`) only, as Sprint 1 (+ a 1.1 architecture-hardening pass) of Enterprise Table V2. Not yet rolled out to any other page — that rollout happens only after this implementation is reviewed and approved.

### Purpose

Lets a user choose which columns are visible on Settlement's table, independently of sorting or filtering. This is the foundation Saved Views will build on later — a "view" will eventually be little more than a named snapshot of this same visibility state (plus, in future sprints, other per-column settings) — but no saved-view mechanism exists yet; only the column model itself is designed to not need reshaping when that arrives.

### Column definition model

A lightweight, page-local model (`ColumnDef`, defined in `app/stlm/page.tsx`) replaces the page's previous hardcoded `{ key, label }[]` array:

```ts
type ColumnDef = {
  id: ColumnKey;
  label: string;
  visible: boolean;
  sortable: boolean;
  hideable: boolean;
  align: 'left' | 'right' | 'center';
};
```

`DEFAULT_COLUMNS` is the single source of truth for all seven of Settlement's columns (Brand, Agent Name, Wallet, Amount, Remarks, Date, Actions). Deliberately excluded from this model: column widths (still `GRID_COLUMN_SIZE`, a separate lookup — layout sizing isn't part of this feature), pinning, and render callbacks — per the explicit scope for this sprint, only what Column Visibility itself needs.

`COLUMN_ALIGN` (used by the existing `renderCell`/`renderSkeletonCell` functions, which only ever receive a bare `ColumnKey`) is now derived from `DEFAULT_COLUMNS` rather than independently hardcoded, so alignment has one source of truth even though two different call sites need to read it.

### Column IDs

A `COLUMN_IDS` constant is the single permanent reference for every column identifier:

```ts
const COLUMN_IDS = {
  BRAND: 'brand',
  AGENT_NAME: 'agentName',
  WALLET: 'wallet',
  AMOUNT: 'amount',
  REMARKS: 'remarks',
  DATE: 'date',
  ACTIONS: 'actions',
} as const;

type ColumnKey = typeof COLUMN_IDS[keyof typeof COLUMN_IDS];
type SortColumn = '' | Exclude<ColumnKey, typeof COLUMN_IDS.ACTIONS>;
```

Every switch/case label and every column-identity comparison in `app/stlm/page.tsx` (`renderCell`, `renderSkeletonCell`, the sort-header JSX, the mobile-truncation check, the export-column filter) reads from `COLUMN_IDS` rather than repeating the raw string. `DEFAULT_COLUMNS`, `GRID_COLUMN_SIZE`, and `COLUMN_ALIGN` all key off the same constants. Both `ColumnKey` and `SortColumn` are now *derived* from `COLUMN_IDS` instead of being hand-written unions that could drift out of sync with it.

This is Settlement-specific today (`COLUMN_IDS` lives in `app/stlm/page.tsx`, not a shared lib) — each page's column set genuinely differs, so a shared constant object would either need to be a union of every page's columns (defeating the point) or be duplicated per page anyway. If a second page adopts Column Visibility, it gets its own `COLUMN_IDS`.

### Behavior

- The header/body/skeleton rendering pipeline all iterate over `visibleColumns` (a `useMemo` filter of `columnDefs` where `visible: true`), not the static column list — hiding a column removes it from all three consistently, with no blank gaps or layout shift (the grid's `gridTemplateColumns` is recomputed from the same filtered list).
- **Actions is never hideable** (`hideable: false`) and never appears in the Columns popover's checkbox list.
- Checking/unchecking a column applies immediately — no Apply button, no confirmation step.
- **Sorting survives hiding.** `sortColumn` is separate state from column visibility; hiding the currently-sorted column doesn't clear or reset it. If that column is hidden and later re-shown, its sort indicator and order are exactly as they were.
- **Export respects visibility** — hidden columns are excluded from the Export-to-Excel output, consistent with Balance/Opening's existing convention.
- **Restore Defaults** (bottom of the popover) resets every column back to `DEFAULT_COLUMNS` (all visible) in one click.
- The mobile card view (`sm:hidden`, small viewports) is **not** column-visibility-aware — it's a fixed compact card layout, not a column-driven grid, and reshaping it was out of scope for this sprint (it wasn't named in the rendering pipeline this sprint targeted, and doing so would risk exactly the "no redesign" this sprint was scoped to avoid).

### Persistence

Same strategy as Sidebar's own panel-open persistence — a plain `localStorage` key (`settlementColumnVisibility`, storing only `{ [columnId]: boolean }`, not the full column model — labels/sortable/align are static and don't need persisting), read once on mount and gated behind a `mounted` flag so the write-effect can't fire during initial render and clobber a saved value back to the default. A page refresh preserves whatever visibility state was last set.

As of the 1.1 hardening pass, the actual `localStorage` read/write no longer happens inline in the page — it goes through a shared helper, **`app/lib/preferences.ts`**:

```ts
getPreference<T>(key: string, fallback: T): T
setPreference<T>(key: string, value: T): void
removePreference(key: string): void
resetPreference<T>(key: string, defaultValue: T): void
```

`getPreference` reads and `JSON.parse`s, returning `fallback` for both a missing key and a malformed/stale value (the try/catch that used to live in Settlement's own mount effect is now inside the helper, so every consumer gets the same "never throw on bad stored JSON" guarantee for free). `setPreference` stringifies and writes. `removePreference` clears a key outright; `resetPreference` is a distinct, separately-named wrapper around `setPreference` for "write a known default back" call sites (e.g. a future Restore-Defaults-style action that wants to explicitly re-assert a default rather than mutate local state and let a write-effect follow) — today it has no call site in Settlement, since Settlement's own Restore Defaults resets React state and lets the existing write-effect persist the result, exactly as before. All four functions no-op safely if called where `window`/`localStorage` doesn't exist (SSR module evaluation), returning the fallback rather than throwing.

Settlement's persistence behavior is unchanged from Sprint 1 — this was a pure extraction, verified via the same QA pass (hide a column, confirm the `localStorage` value, reload, confirm it's still hidden).

### Accessibility

- Trigger button: `aria-haspopup="true"`, `aria-expanded`, `aria-controls` pointing at the popover's `id`.
- Popover: `role="dialog"`, `aria-label="Column visibility"`.
- **Enter or Space on the trigger opens the popover and moves focus to its first checkbox automatically.** This was a real bug caught during QA, not a hypothetical: the popover portals to the end of `document.body` (same pattern as every other dropdown in this codebase), which sits outside the trigger button's natural Tab order — without the auto-focus, Tab from the trigger skipped over the popover entirely to whichever element happened to be next in the page's own layout. Moving focus into the popover on open (once the portal has actually mounted) is what makes it keyboard-reachable at all.
- From there, Tab/Shift+Tab move between checkboxes and the Restore Defaults button normally (they're plain native `<input type="checkbox">`/`<button>` elements — no custom tab handling needed once focus is inside).
- **Escape** closes the popover and returns focus to the trigger button.
- Clicking outside the popover closes it (same outside-click pattern used by every other dropdown in this codebase).
- Not implemented: a full focus trap (Tab wrapping from the last control back to the first). Not required by this sprint's spec, and adding one would be exactly the kind of ahead-of-need complexity this sprint was scoped to avoid.

**1.1 audit:** width, alignment, checkbox spacing, keyboard focus, Escape, and focus-return were each re-checked against the rest of the app's established dropdown conventions (the width/border/radius/shadow already matched the app-wide Filter-dropdown pattern used on Balance/Opening/Top Up/Transfer Queue; the checkbox row spacing and hover states already matched Settlement's own `RowActionsCell` dropdown; the section-label and Restore Defaults link colors already matched Settlement's own `#2563EB`/`#EFF6FF` accent pair). No inconsistencies were found, so nothing was changed cosmetically for its own sake — the one real fix that came out of this feature's QA was the auto-focus-on-open behavior above, which was a functional bug, not a style one.

### Performance

Visibility changes only update `columnDefs` state; header/row/skeleton rendering reads the same memoized `visibleColumns` derivation, so toggling a column re-renders the table's contents (correctly — the visible column set genuinely changed) without remounting `DataTable`, resetting scroll position, or touching unrelated state (search term, sort, pagination, selected row).

### Future expansion path

Verified (not implemented) that `ColumnDef` doesn't block the capabilities Enterprise Table V2 is expected to grow into later:

- **Width** — currently lives in a separate `GRID_COLUMN_SIZE` lookup, not on `ColumnDef`. Adding an optional `width?: string` to `ColumnDef` later is a purely additive type change; nothing today would need to be restructured to accommodate it.
- **Pinned columns** — an optional `pinned?: 'left' | 'right' | false` field would be equally additive. `app/agentbal/page.tsx`'s existing (currently-unused) `STICKY_COLS`/`stickyLeft` pattern is already proven prior art in this codebase for computing sticky-offset CSS from a filtered column list, so a future pinning implementation has a real precedent to build from, not a blank page.
- **Ordering** — already works today with zero changes: `visibleColumns` is a `.filter()` over `columnDefs`, which preserves array order. A future drag-to-reorder feature only needs to reorder the `columnDefs` array itself (e.g. `setColumnDefs(reordered)`); every consumer (header, rows, skeleton, `gridTemplateColumns`) already renders in whatever order `columnDefs` is in.

No speculative fields were added to `ColumnDef` to "prepare" for this — per this sprint's own scope, the model only carries what Column Visibility needs today.
