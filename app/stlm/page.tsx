'use client';

import { useEffect, useState, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  Search,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Download,
  ArrowLeftRight,
  RefreshCw,
  MoreVertical,
  Copy,
  Columns3,
  Pencil,
  Eye,
  Trash2,
  Inbox,
  Hash,
  Banknote,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import SettlementHeader from '../components/SettlementHeader';
import ConnectionErrorState from '../components/ConnectionErrorState';
import TableFooter from '../components/TableFooter';
import Toolbar from '../components/Toolbar';
import EmptyState from '../components/EmptyState';
import DataTable from '../components/DataTable';
import RecordFormModal, { type RecordFormField } from '../components/RecordFormModal';
import { SETTLEMENT_BRAND_OPTIONS, CASHOUT_WALLET_OPTIONS, SETTLEMENT_REMARKS_SUGGESTIONS } from '../lib/settlementOptions';
import AddRecordDropdown from '../components/AddRecordDropdown';
import BulkImportModal from '../components/BulkImportModal';
import BulkEditModal, { type BulkEditUpdates } from '../components/BulkEditModal';
import { classifyFetchError, type ClassifiedError } from '../lib/errors';
import { rawVal, displayNum, parseAmount, fmt, fmtAbbrev } from '@/app/lib/format';
import { isToday, isYesterday } from '../lib/businessDate';
import { getPreference, setPreference } from '../lib/preferences';
import { TABLE_STICKY_HEADER_SHADOW_CLASS } from '../design-system/shadows';
import { calculateColumnLayout, type ColumnLayout } from '../lib/columnLayout';

// Ghost button: 36px height, 8px radius, subtle #E2E8F0 border, #F8FAFC
// hover fill — the toolbar's shared control style (Refresh/Export).
const GHOST_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[#E2E8F0] px-3 text-[13px] font-medium text-[#475569] transition-[color,background-color,transform] duration-150 ease-[var(--ease-out-strong)] hover:bg-[#E2E8F0] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// EmptyState's action button — Settlement composes this itself now that
// EmptyState takes a generic `action` node instead of a hardcoded
// Clear-Filters/Refresh pair.
const EMPTY_STATE_ACTION_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] border border-[#E5E7EB] px-3 text-[13px] font-medium text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:border-[#3a3a3d] dark:text-[#9CA3AF] dark:hover:bg-white/5';

// The genuinely-no-data empty state's "Add Record" is the one primary
// action on that screen (opens the same New Record modal as the toolbar's
// own Add dropdown) — filled accent, not the ghost/outline style the
// search-cleared/no-results state's "Clear Search" uses.
const EMPTY_STATE_PRIMARY_BUTTON =
  'inline-flex h-9 items-center rounded-[8px] bg-indigo-600 px-4 text-[13px] font-medium text-white transition-colors hover:bg-indigo-700';

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

type SettlementKpiStats = {
  todayCount: number;
  todayAmount: number;
  yesterdayCount: number;
  yesterdayAmount: number;
};

const EMPTY_KPI_STATS: SettlementKpiStats = { todayCount: 0, todayAmount: 0, yesterdayCount: 0, yesterdayAmount: 0 };

// Wraps the matched portion of `text` in <mark> — case-insensitive, every
// occurrence (not just the first). Row height never changes since <mark>
// is inline; sorting/filtering both key off the raw underlying values,
// never this rendered node, so highlighting can't affect either. Empty
// query (or no match at all) returns the plain string unchanged.
function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-[2px] bg-[#BFDBFE] text-inherit dark:bg-[rgba(37,99,235,0.4)]">{part}</mark>
    ) : (
      part
    )
  );
}

type StlmRow = {
  agentName: string;
  amount: string;
  remarks: string;
  date: string;
  wallet: string;
  brand: string;
  // Sequential index assigned once at fetch time — the row-selection
  // checkbox system's only stable identity, since nothing in the sheet
  // itself provides one. Survives sort/search/pagination (those only
  // reorder/filter/slice the same row objects, never rebuild them), so a
  // Set<number> of these stays correct across all three; only a real
  // refetch (new row objects) invalidates it, which is exactly when
  // selection should clear anyway.
  _id: number;
};

// "AG BD STLM + TOPUP" no longer carries a brand/gateway column (removed from
// the sheet), so brand is resolved by cross-referencing the bare agent code
// against "SSP AG BalanceLimit" (same Group data and priority logic Cashout's
// own Agent Balance page already uses), not by mapping a gateway label.
const BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
const SKIP_GROUPS = ['wallet with issue', 'disconnected', 'dc account'];

function computeBrand(groups: string[]): string {
  const counts = new Map<string, number>();
  groups.forEach((group) => {
    const trimmed = (group ?? '').trim();
    if (!trimmed || trimmed === '-') return;
    if (SKIP_GROUPS.some((skip) => trimmed.toLowerCase().includes(skip))) return;
    const code = trimmed.slice(0, 2).toUpperCase();
    counts.set(code, (counts.get(code) ?? 0) + 1);
  });

  if (counts.size === 0) return '−';

  const maxCount = Math.max(...counts.values());
  const tied = Array.from(counts.keys()).filter((code) => counts.get(code) === maxCount);
  const priorityTied = tied.filter((code) => BRAND_PRIORITY.includes(code));

  if (priorityTied.length > 0) {
    priorityTied.sort((a, b) => BRAND_PRIORITY.indexOf(a) - BRAND_PRIORITY.indexOf(b));
    return priorityTied[0];
  }

  tied.sort((a, b) => a.localeCompare(b));
  return tied[0];
}

const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

function resolveBrand(groups: string[], agentName: string): string {
  const brand = computeBrand(groups);
  if (brand !== '−') return brand;
  return BRAND_CODES.find((code) => agentName.toUpperCase().includes(code)) ?? '−';
}

// Read directly off the shop name as displayed, e.g. "KONAN001-M1" -> "M1"
// — authoritative when present. A cross-reference-only version of this page
// (no suffix check at all) was verified against a real pivot table to
// misattribute brand for a meaningful share of shops; this suffix (checked
// first, same priority as app/topup/page.tsx and app/page.tsx's own SSP
// Line 1 table) is what those pages now trust over the cross-reference.
function extractBrandSuffix(name: string): string | null {
  const parts = name.split('-');
  const last = parts[parts.length - 1]?.toUpperCase();
  return parts.length >= 2 && BRAND_CODES.includes(last) ? last : null;
}

// A handful of shops use Send Money's own wallet-naming convention instead
// of the trailing-suffix one above — brand right after the FIRST hyphen, as
// exactly "<code>AG", not the last segment — e.g. "T-B5AG-BURMA001-NG" or,
// with an extra mid-tier code segment, "N-K1AG-J3-AVENT001-BK". Segment
// count varies (4 or 5 parts seen live); matched on segment 1 alone, not a
// fixed length.
function extractBrandAltFormat(name: string): string | null {
  const segment = (name.split('-')[1] ?? '').toUpperCase();
  return BRAND_CODES.find((code) => segment === `${code}AG`) ?? null;
}

// "To Agent" values on the new sheet sometimes carry a trailing "-<brand>"
// suffix (e.g. "KONAN001-M1"), sometimes not (e.g. "YUJI024") — strip it so
// the bare code matches "SSP AG BalanceLimit"'s own (always-bare) wallet names.
function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && BRAND_CODES.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Display-only reformat of the raw "M/D/YYYY" sheet value into "Jul 21,
// 2026" — the raw string itself is still what isToday()/sorting/search key
// off of, this never touches the underlying data.
function formatDateDisplay(dateStr: string): string {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return dateStr;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return dateStr;
  return `${MONTH_ABBR[m - 1]} ${d}, ${y}`;
}

// Permanent column identifiers — the single canonical reference for every
// place that needs to name a specific column (switch/case labels,
// comparisons, DEFAULT_COLUMNS itself) instead of scattering the same raw
// string literal through the file. Settlement-specific today (each page's
// own column set differs) — if/when this rolls out elsewhere, each page
// gets its own COLUMN_IDS rather than sharing one.
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

// Column definition — Enterprise Table V2's Column Visibility metadata
// (Sprint 1) plus Adaptive Column Width Distribution's sizing model
// (Sprint 3): minWidth/preferredWidth (px) + grow (relative share of any
// space left over once every column has its preferred width). Deliberately
// nothing beyond these three sizing fields — no pinning/render callbacks;
// verified in docs/DESIGN_SYSTEM.md §10 that adding those later doesn't
// require restructuring this shape.
type ColumnDef = {
  id: ColumnKey;
  label: string;
  visible: boolean;
  sortable: boolean;
  hideable: boolean;
  align: 'left' | 'right' | 'center';
  minWidth: number;
  preferredWidth: number;
  grow: number;
};

// Sprint 3.3 visual balancing pass. Sprint 3.2 fixed Date/Remarks
// over-growth by concentrating nearly all grow weight onto Agent Name
// (3.2 vs everyone else ≤1.0) — but that just moved the "one column eats
// all the surplus" problem onto Agent Name instead (it alone absorbed
// ~55% of available extra space on a wide desktop viewport). The fix here
// is spreading growth across all four flexible columns so the row reads as
// a smooth ascending rhythm (Actions/Brand/Date fixed and small → Amount/
// Wallet modest → Agent Name/Remarks the two genuine peaks, nearly equal)
// rather than one column dwarfing the rest 3:1.
//
// Considered `maxWidth` (explicitly allowed this sprint) instead of
// retuning grow, but rejected it: a cap set to what Agent Name/Remarks'
// real content actually needs (a few hundred px) is well below this page's
// realistic desktop/laptop container widths, so once every flexible
// column hit its cap the leftover surplus wouldn't have anywhere left to
// go — it would sit as dead space *after* the last column (Actions),
// since flex packs items from the start. That's the same symptom in a
// different place, not a fix. Spreading grow instead means the surplus
// always has somewhere proportionate to go, at every width tested.
//   anchored Date 0, Brand 0, Actions 0 — fixed-shape content
//            (formatted date, badge code, icon button); unchanged from 3.2
//   modest   Wallet 1.0, Amount 0.7 — some adaptive room, not a lot
//   peak     Agent Name 1.6, Remarks 1.0 — genuinely benefit from room;
//            Agent Name stays somewhat ahead (more variable real content:
//            "N-M2ag-J3-Agate005-Bk" vs Remarks' typically short enum
//            labels), but no longer 3x+ everyone else combined
//
// Sprint 3.4 content-alignment audit — align picked per content type, not
// per current implementation, sizing untouched:
//   Brand centered (was left): a small pill in a FIXED 90px column (grow:
//   0) — centering keeps it at a stable, predictable position regardless
//   of viewport, and the badge is small enough that centering doesn't
//   crowd it against the column's padding.
//   Wallet left (was centered): its column is adaptive (grow: 1.0, ranges
//   ~90-230px across tested viewports) — centering a badge in a column
//   whose width keeps changing makes the badge visually drift left/right
//   as the layout resizes. Left-aligning gives it the same stable anchor
//   Agent Name/Remarks already have, so any extra room the column grows
//   into reads as trailing space after the badge, not a shifting badge.
//   Agent Name/Amount/Remarks/Date/Actions unchanged — already matched
//   their content type (free text left, numbers/dates right, icon
//   button centered).
//
// Post-3.4 visual balancing pass — judged by screenshots at 768-1920px,
// not by recalculating ratios (numeric grow-tuning across 3.1-3.3 kept
// concentrating the "who eats the surplus" problem into a single column
// instead of removing it). Findings that drove this pass:
//   - Left-aligned text/badge columns (Agent Name, Wallet, Remarks) show
//     any surplus width as literal trailing blank space, since the content
//     doesn't stretch to fill it — so a column's *rendered* width, not
//     just its grow number, determines whether it reads as an "empty
//     island." Wallet/Remarks' old preferred widths (130/280) already
//     overshot their real content (a short pill; short enum labels like
//     "STLM TO MC") even before any grow was applied.
//   - Reduced Wallet/Amount/Remarks' preferredWidth close to their real
//     content size and cut their grow substantially, so they read as
//     compact metadata columns (the way Notion/Linear/GitHub Projects size
//     a tag or property column) rather than stretched ones.
//   - Let Agent Name lead as the one clearly primary column (same
//     convention as a "Title"/"Name" column in those tools) — but capped
//     its own grow back down from an initial 2.8 to 2.0 after an 1920px
//     screenshot showed IT developing the same trailing-gap symptom once
//     it was over-grown; redistributed that difference across
//     Wallet/Amount/Remarks (0.3→0.5 each) so an ultra-wide viewport's
//     extra surplus spreads across several columns instead of piling into
//     any single one.
//   - Verified at 768/1024/1280/1440/1920px: 768 correctly hits minWidth
//     and scrolls; 1024-1440 read as evenly balanced with no dominant gap;
//     1920 is looser overall (expected — genuinely more space than the
//     row's content needs) but no longer concentrated into one column.
// SPRINT 4 — TEMPORARY fixed-width visual mockup values. grow/minWidth
// below are now inert (see toFlexColumnStyle) and left untouched so the
// adaptive engine's own tuned values survive for when it's reinstated;
// only preferredWidth is being treated as the literal fixed px width for
// this pass, chosen by iterative screenshot review, not by any formula.
// Balanced-layout pass: text columns left, numeric/date columns right,
// Actions (an icon button, neither text nor number) stays centered. Agent
// Name and Remarks are the two "important" columns (Name/Description
// equivalents) that get real breathing room — and, critically, SHARE the
// leftover row width between them (grow:1 each, see toFlexColumnStyle)
// instead of dumping all of it into Agent Name alone. A single column
// absorbing 100% of the leftover space read as lopsided at normal desktop
// widths (a huge column with visible dead space after short values, while
// everything else looked squeezed together on the right) — splitting the
// growth in two keeps both columns comfortably sized without either one
// dominating. Every other column is sized to its own real content — a
// compact badge (Brand/Wallet), a formatted number/date (Amount/Date), or
// an icon button (Actions) — and stays exactly that width, no wider. No
// invisible spacer columns (removed the Brand<->Agent Name and
// Amount<->Remarks gaps from an earlier pass) — they made the row harder
// to visually balance than just letting real columns absorb the space.
// preferredWidth values below mirror Send Money Settlement's own final
// column-width arrangement (app/sendmoney/settlement/page.tsx's
// columnWidths, tuned there through several rounds of explicit px shifts),
// converted from percentages back to px at this same table's own measured
// 1319px width — both pages render at the same width, so the ratio carries
// over directly. Their sum (~1318px) lands almost exactly at the container
// width, so Cashout's existing flexGrow:1 (non-Remarks) redistributes
// essentially nothing extra — these px values ARE the rendered widths.
const DEFAULT_COLUMNS: ColumnDef[] = [
  // Brand -30px / Actions +30px — real preferredWidth numbers (this split
  // alone can't fix the checkbox-column overflow — see the calc() reserved
  // directly on Brand's flexBasis in flexStyleById below for that part).
  { id: COLUMN_IDS.BRAND, label: 'Brand', visible: true, sortable: true, hideable: true, align: 'left', minWidth: 90, preferredWidth: 149, grow: 0 },
  { id: COLUMN_IDS.AGENT_NAME, label: 'Agent Name', visible: true, sortable: true, hideable: true, align: 'left', minWidth: 140, preferredWidth: 216, grow: 1 },
  { id: COLUMN_IDS.WALLET, label: 'Wallet', visible: true, sortable: true, hideable: true, align: 'center', minWidth: 90, preferredWidth: 208, grow: 0 },
  { id: COLUMN_IDS.AMOUNT, label: 'Amount', visible: true, sortable: true, hideable: true, align: 'center', minWidth: 115, preferredWidth: 244, grow: 0 },
  { id: COLUMN_IDS.REMARKS, label: 'Remarks', visible: true, sortable: true, hideable: true, align: 'center', minWidth: 160, preferredWidth: 243, grow: 1 },
  { id: COLUMN_IDS.DATE, label: 'Date', visible: true, sortable: true, hideable: true, align: 'right', minWidth: 110, preferredWidth: 149, grow: 0 },
  { id: COLUMN_IDS.ACTIONS, label: 'Action', visible: true, sortable: false, hideable: false, align: 'center', minWidth: 56, preferredWidth: 109, grow: 0 },
];

const COLUMN_VISIBILITY_STORAGE_KEY = 'settlementColumnVisibility';

// Adaptive Column Width Distribution (Sprint 3), decoupled from its
// renderer (Sprint 3.1) — app/lib/columnLayout.ts's calculateColumnLayout()
// is the renderer-agnostic sizing engine; everything below is this page's
// own Flex-specific translation of that output, and is the ONLY place in
// this file that knows Flex exists. flex-basis starts every column at its
// preferredWidth; flex-grow distributes any leftover space (available -
// total preferred) proportionally once every column already has its
// preferred width; the browser's native flex-shrink (proportional to each
// item's own basis) handles the opposite case, but never below min-width,
// which is a hard floor CSS itself enforces. Once every visible column is
// at its floor and still doesn't fit, the row overflows and DataTable.
// ScrollArea's existing `overflow-x-auto` (see app/components/DataTable.tsx)
// picks it up as horizontal scroll — no JS measurement/ResizeObserver
// needed, the browser recalculates this on every resize for free. Header,
// skeleton, and body rows all read the same per-column values, which is
// what keeps them pixel-aligned with each other and with the footer below.
//
// A future Grid renderer would write its own toGridColumnStyle(layout)
// (e.g. returning { gridColumn: ... } or contributing to a template
// string) from the exact same ColumnLayout input; a native <table>
// renderer would write its own toTableColWidth(layout) for a <col>
// element. Neither touches calculateColumnLayout.
//
// Every column shares any leftover row width equally (flexGrow:1) EXCEPT
// Remarks, which stays pinned to its own preferredWidth. Remarks holds
// short, plain (non-badge) text ("STLM TO MC") — growing its column the
// same as everyone else left that text stranded with a large empty gap
// trailing after it (badges like Brand/Wallet read fine with extra
// surrounding space; a bare left-aligned string does not, it just looks
// orphaned in an oversized box). Excluding it from growth keeps its column
// close to what the text actually needs, so any leftover space goes to the
// other six columns instead. flexShrink:0 throughout means no column
// shrinks below its own preferredWidth; if the row still doesn't fit,
// DataTable.ScrollArea's `overflow-x-auto` handles it as horizontal scroll.
// flexBasis is each column's own preferredWidth in px, with a real CSS
// minWidth floor and flexShrink enabled — not the % of total-preferred-width
// trick a previous version used. That % approach kept proportions locked to
// Send Money Settlement's own tuned ratios, but only Brand ever got an actual
// floor (via a one-off calc(%, - 44px) clamp for the checkbox column), so at
// a narrow-enough container (verified live: viewport 1280px, no zoom
// involved) Brand alone stopped shrinking while every other column's %
// basis kept assuming it hadn't — the row's total then exceeded the
// container by a few px and DataTable.ScrollArea's overflow-x-auto showed a
// permanent horizontal scrollbar under completely ordinary conditions, not
// just extreme zoom. Real flexShrink + minWidth on every column lets the
// browser's own flex algorithm redistribute the squeeze across all of them
// at once (shrinking only the columns that haven't hit their floor yet),
// exactly like a native flex layout is supposed to — the row only truly
// overflows once every column is already at its own minWidth floor.
function toFlexColumnStyle(layout: ColumnLayout<ColumnKey>): CSSProperties {
  return {
    flexGrow: layout.id === COLUMN_IDS.REMARKS ? 0 : 1,
    flexShrink: 1,
    flexBasis: `${layout.preferredWidth}px`,
    minWidth: `${layout.minWidth}px`,
  };
}

// Alignment rule: text left, numbers/currency/dates right, actions center.
// Brand reads as a text label (not a colored status badge), so it stays
// left. Derived from DEFAULT_COLUMNS (single source of truth) rather than
// duplicated here — renderCell/renderSkeletonCell only ever see a bare
// ColumnKey, not the full column def, so this lookup stays as their access
// point to alignment.
const COLUMN_ALIGN: Record<ColumnKey, 'left' | 'right' | 'center'> = Object.fromEntries(
  DEFAULT_COLUMNS.map((col) => [col.id, col.align])
) as Record<ColumnKey, 'left' | 'right' | 'center'>;

// Column header text is always Title Case, never uppercase — including
// Brand (earlier drafts shouted brand codes in caps; corrected per the v3
// spec's explicit "never FULL UPPERCASE" rule). Header should not shout —
// 14px/600/#475569 on a #FAFAFB band, not 16px/bold/black; it's a label,
// the data is the hero.
function headerCellClasses(_active: boolean, _isBrand: boolean, align: 'left' | 'right' | 'center', paddingCls: string = 'px-4') {
  return `group flex items-center text-${align} ${paddingCls} text-[14px] leading-[20px] font-semibold text-[#475569] dark:text-[#9CA3AF] whitespace-nowrap ${
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
  }`;
}

// Sort indicator is always visible (never hover-only, per v3 — discovery
// mattered more than a clean header) at a quiet Gray-400, and switches to
// Primary blue once active. Rendered in its own fixed-size wrapper so the
// label's position never shifts between the unsorted/ascending/descending
// states — only the icon glyph changes, the reserved width doesn't.
function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  return (
    <span className="flex w-3.5 shrink-0 items-center justify-center transition-colors duration-150 ease-out">
      {!active ? (
        <ChevronsUpDown size={14} className="text-[#94A3B8]" />
      ) : direction === 'asc' ? (
        <ChevronUp size={14} className="text-[#2563EB]" />
      ) : (
        <ChevronDown size={14} className="text-[#2563EB]" />
      )}
    </span>
  );
}

// Source data comes in as raw uppercase (e.g. "GEKKO005", "NAGAD") — proper-
// cased for display only (e.g. "Gekko005", "Nagad"); Brand stays untouched
// since its own values (M1, B2, ...) are codes, not prose. Splits on
// whitespace/hyphens so compound names like "N-B4AG-A2-FRANCH001-BK" still
// read sensibly ("N-B4ag-A2-Franch001-Bk") instead of one long capitalized
// blob.
function toProperCase(str: string): string {
  return str
    .toLowerCase()
    .split(/([\s-]+)/)
    .map((part) => (/^[\s-]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

// Per-code tint map — same scheme as Balance's own BrandBadge
// (app/agentbal/page.tsx), applied here too. Unknown codes fall back to the
// same neutral slate this badge used exclusively before.
const BRAND_BADGE_TINTS: Record<string, string> = {
  M1: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-900/50',
  M2: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-500/10 dark:text-cyan-400 dark:border-cyan-900/50',
  B1: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-900/50',
  B2: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-400 dark:border-violet-900/50',
  B3: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-500/10 dark:text-fuchsia-400 dark:border-fuchsia-900/50',
  B4: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-400 dark:border-indigo-900/50',
  B5: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-900/50',
  K1: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-400 dark:border-orange-900/50',
  J1: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-900/50',
  T1: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-500/10 dark:text-teal-400 dark:border-teal-900/50',
};

function brandBadgeClasses(brand: string): string {
  return BRAND_BADGE_TINTS[brand] ?? 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700';
}

// Brand: 999px radius, 28px tall, 0/10px padding, 12px/600 — reads as a
// proper identifying tag. Fixed height (not vertical padding) keeps every
// badge the same size regardless of glyph ascenders/descenders in the brand
// code. `brand` carries the raw code for the color lookup — `children` is
// the (possibly search-highlighted) display content, which can differ from
// the raw string.
function BrandBadge({ children, brand }: { children: React.ReactNode; brand: string }) {
  return (
    <span className={`inline-flex h-[28px] items-center rounded-[999px] border px-[10px] text-[12px] font-semibold transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${brandBadgeClasses(brand)}`}>
      {children}
    </span>
  );
}

// Wallet: a subtler pill — #F8FAFC bg, 1px #E5E7EB border, 999px radius,
// 24px tall, 4px/8px padding, 12px/500.
// Per-wallet tint map — each wallet's own real brand color (Nagad orange,
// Rocket purple, Bkash pink, Upay red), same light-bg/border/text pattern as
// BrandBadge's tint map. Unknown values fall back to the same neutral slate
// this badge used exclusively before.
const WALLET_BADGE_TINTS: Record<string, string> = {
  NAGAD: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-400 dark:border-orange-900/50',
  ROCKET: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-900/50',
  BKASH: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-500/10 dark:text-pink-400 dark:border-pink-900/50',
  UPAY: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-900/50',
};

function walletBadgeClasses(wallet: string): string {
  return WALLET_BADGE_TINTS[wallet.toUpperCase()] ?? 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700';
}

// `wallet` carries the raw value for the color lookup — `children` is the
// (possibly search-highlighted, proper-cased) display content.
function WalletBadge({ children, wallet }: { children: React.ReactNode; wallet: string }) {
  return (
    <span className={`inline-flex h-[24px] items-center rounded-[999px] border px-2 py-1 text-[12px] font-medium transition-[filter] duration-150 hover:brightness-95 dark:hover:brightness-110 ${walletBadgeClasses(wallet)}`}>
      {children}
    </span>
  );
}

// Re-triggers a short opacity+translateY fade whenever `value` changes (e.g.
// after Refresh resolves with new numbers) — same pattern as
// SettlementSummary's own FadeValue, duplicated here since this page's KPI
// cards are now bespoke, not built on that shared component.
function FadeValue({ value, className }: { value: string; className: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(false);
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <p
      className={`${className} transition-[opacity,transform] duration-200 ease-out ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-[5px]'
      }`}
    >
      {value}
    </p>
  );
}

// Row actions menu (⋮) — self-contained local state + a portal dropdown.
// Edit opens the (UI-only, prototype) RecordFormModal via the onEdit
// callback lifted to the page; View Details/Delete are disabled placeholders
// for a future CRUD flow, per spec — not wired to anything yet.
function RowActionsCell({ row, onEdit }: { row: StlmRow; onEdit: (row: StlmRow) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Keeps the portal mounted for 150ms after close so the closing
  // opacity/scale transition (driven by `open` below) can play before React
  // unmounts it — same pattern as the Columns menu.
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    if (open) {
      setRendered(true);
    } else {
      const timeout = setTimeout(() => setRendered(false), 150);
      return () => clearTimeout(timeout);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        btnRef.current && !btnRef.current.contains(target) &&
        menuRef.current && !menuRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const copyRow = () => {
    const text = [
      `Brand: ${row.brand}`,
      `Agent Name: ${toProperCase(row.agentName)}`,
      `Wallet: ${toProperCase(row.wallet)}`,
      `Amount: ${displayNum(row.amount)}`,
      `Remarks: ${row.remarks}`,
      `Date: ${formatDateDisplay(row.date)}`,
    ].join('\n');
    navigator.clipboard?.writeText(text).catch(() => {});
    setOpen(false);
  };

  return (
    <span className="relative inline-flex" onClick={(event) => event.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        aria-label="Row actions"
        onClick={(event) => {
          event.stopPropagation();
          const rect = btnRef.current?.getBoundingClientRect();
          if (rect) setPos({ top: rect.bottom + 4, left: rect.right - 144 });
          setOpen((current) => !current);
        }}
        className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[#94A3B8] transition-[color,background-color,transform] duration-150 ease-[var(--ease-out-strong)] hover:bg-[#F1F5F9] hover:text-[#475569] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:hover:bg-white/5"
      >
        <MoreVertical size={16} />
      </button>
      {rendered && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, transformOrigin: 'top right' }}
          className={`z-[9999] w-36 rounded-xl border border-[#e5e5e7] bg-white p-1 shadow-xl transition-[transform,opacity] duration-150 ease-[var(--ease-out-strong)] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] ${
            open ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
          }`}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => { setOpen(false); onEdit(row); }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5"
          >
            <Pencil size={13} />
            Edit
          </button>
          <button
            type="button"
            onClick={copyRow}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5"
          >
            <Copy size={13} />
            Copy row
          </button>
          <div className="my-1 border-t border-[#F1F5F9] dark:border-[#2f2f32]" />
          <button
            type="button"
            disabled
            title="Coming soon"
            className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#b3b8c2] dark:text-[#5a5f66]"
          >
            <Eye size={13} />
            View Details
          </button>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#b3b8c2] dark:text-[#5a5f66]"
          >
            <Trash2 size={13} />
            Delete
          </button>
        </div>,
        document.body
      )}
    </span>
  );
}

// Widths chosen from measuring the REAL rendered table (Puppeteer, Range-
// based text-width against each cell's own box), not guessed:
//   Agent Name: real short agent codes measure ~30-35%, real long ones up to
//     ~69% — 55/70/85 spans that spread realistically.
//   Amount: real 5-6 digit values measure a stable ~25-28% — tight variation
//     around that, not spec's original wide range, since real amounts don't
//     actually vary much in digit count.
//   Remarks: real values measure ~34-56% here — 50/65/80 covers that plus
//     headroom for longer remarks text not seen in this sample.
//   Date: Cashout's own formatted "Jul 23, 2026" measures a near-constant
//     ~50-52% — a single close value, not a rotating range, since the
//     format's length barely varies row to row (unlike Send Money's own
//     shorter "7/23/2026", which gets its own tighter value).
//   Wallet: real badges measure 48-61px — fixed px (not %), since badge
//     content (Nagad/Upay/Bkash/Rocket) is short, fixed-ish text, not
//     proportional to column width.
const AGENT_NAME_SKELETON_WIDTHS = [55, 70, 85];
const REMARKS_SKELETON_WIDTHS = [50, 65, 80];
const AMOUNT_SKELETON_WIDTHS = [26, 30, 24, 28];
const WALLET_SKELETON_WIDTHS = [48, 60, 52, 56];

// Skeleton mirrors renderCell's own shapes per column (badge → pill, pill
// → pill, number/date → short right-aligned bar) instead of one generic bar
// repeated across every column, so the loading state reads as a blurred
// version of the real table rather than a placeholder grid. Header labels
// are NEVER part of this — only body/data cells shimmer.
function renderSkeletonCell(col: ColumnDef, rowIndex: number, style: CSSProperties) {
  const key = col.id;
  const base = 'flex items-center px-4 py-[14px]';
  switch (key) {
    case COLUMN_IDS.BRAND:
      // Pill (h-[28px] w-9 rounded-full), not a circle — matches the real
      // BrandBadge's own height exactly and its typical rendered width
      // (measured ~30-38px for real 2-char codes).
      return (
        <div key={key} role="cell" style={style} className={base}>
          <div className="dt-skeleton h-[28px] w-9 rounded-full" />
        </div>
      );
    case COLUMN_IDS.AGENT_NAME:
      return (
        <div key={key} role="cell" style={style} className={base}>
          <div
            className="dt-skeleton h-3 rounded-md"
            style={{ width: `${AGENT_NAME_SKELETON_WIDTHS[rowIndex % AGENT_NAME_SKELETON_WIDTHS.length]}%` }}
          />
        </div>
      );
    case COLUMN_IDS.WALLET:
      return (
        <div key={key} role="cell" style={style} className={`${base} justify-center`}>
          <div
            className="dt-skeleton h-6 rounded-full"
            style={{ width: WALLET_SKELETON_WIDTHS[rowIndex % WALLET_SKELETON_WIDTHS.length] }}
          />
        </div>
      );
    case COLUMN_IDS.AMOUNT:
      return (
        <div key={key} role="cell" style={style} className={`${base} justify-center`}>
          <div className="dt-skeleton h-3 rounded-md" style={{ width: `${AMOUNT_SKELETON_WIDTHS[rowIndex % AMOUNT_SKELETON_WIDTHS.length]}%` }} />
        </div>
      );
    case COLUMN_IDS.REMARKS:
      return (
        <div key={key} role="cell" style={style} className={base}>
          <div
            className="dt-skeleton h-3 rounded-md"
            style={{ width: `${REMARKS_SKELETON_WIDTHS[rowIndex % REMARKS_SKELETON_WIDTHS.length]}%` }}
          />
        </div>
      );
    case COLUMN_IDS.DATE:
      return (
        <div key={key} role="cell" style={style} className={`${base} justify-end`}>
          <div className="dt-skeleton h-3 rounded-md" style={{ width: '50%' }} />
        </div>
      );
    case COLUMN_IDS.ACTIONS:
      // h-8 w-8 rounded-[8px] — matches RowActionsCell's real button exactly
      // (was h-7 rounded-full, a different size/shape from the real kebab
      // button it's standing in for).
      return (
        <div key={key} role="cell" style={style} className={`${base} justify-center`}>
          <div className="dt-skeleton h-8 w-8 rounded-[8px]" />
        </div>
      );
    default:
      return null;
  }
}

// Body text is dark enough to read, not pure black — #111827/#E5E7EB,
// 13px/400/20px line-height uniformly across every column (no muted-vs-
// foreground split; that hierarchy now comes from the header/body contrast
// itself, not per-column dimming). Cell padding is 14px vertical/16px
// horizontal per spec.
function renderCell(row: StlmRow, col: ColumnDef, style: CSSProperties, onEdit: (row: StlmRow) => void, searchTerm: string) {
  const key = col.id;
  // Amount is now center-aligned like Wallet/Remarks (was right-aligned
  // with its own pl-4 pr-28 breathing-room padding) — plain px-4 for every
  // column, matching the other center columns.
  const base = `whitespace-nowrap overflow-hidden text-ellipsis px-4 py-[14px] text-${COLUMN_ALIGN[key]} text-[13px] leading-[20px] font-normal text-[#111827] dark:text-[#E5E7EB]`;
  switch (key) {
    case COLUMN_IDS.BRAND:
      return <div key={key} role="cell" style={style} className={base}><BrandBadge brand={row.brand}>{highlightMatch(row.brand, searchTerm)}</BrandBadge></div>;
    case COLUMN_IDS.AGENT_NAME: {
      // Uppercased for display (kept from the earlier "capitalize Agent
      // Name" request — not part of this column-sizing revert).
      const agentNameText = row.agentName.toUpperCase();
      return <div key={key} role="cell" style={style} title={agentNameText} className={base}>{highlightMatch(agentNameText, searchTerm)}</div>;
    }
    case COLUMN_IDS.WALLET:
      return <div key={key} role="cell" style={style} className={base}><WalletBadge wallet={row.wallet}>{highlightMatch(toProperCase(row.wallet), searchTerm)}</WalletBadge></div>;
    case COLUMN_IDS.AMOUNT:
      // Numbers get their own smaller size (12px) per spec, overriding the
      // table body's 13px base — !important since both are arbitrary
      // text-size values and would otherwise fight over CSS output order.
      // Amount is bolded (600) to stand out as the primary figure.
      return <div key={key} role="cell" style={style} className={`${base} !text-[12px] font-semibold tabular-nums`}>{highlightMatch(displayNum(row.amount), searchTerm)}</div>;
    case COLUMN_IDS.REMARKS: {
      // rawVal() never returns '' — blanks come through as '-', which reads
      // like a typo next to real remarks. Normalize to the project's own
      // empty-cell convention (U+2212) instead of leaving it ambiguous.
      const remarksText = row.remarks && row.remarks !== '-' ? row.remarks : '−';
      return <div key={key} role="cell" style={style} title={remarksText} className={base}>{highlightMatch(remarksText, searchTerm)}</div>;
    }
    case COLUMN_IDS.DATE: {
      const dateText = formatDateDisplay(row.date);
      return <div key={key} role="cell" style={style} className={base}>{highlightMatch(dateText, searchTerm)}</div>;
    }
    case COLUMN_IDS.ACTIONS:
      return <div key={key} role="cell" style={style} className={`${base} flex items-center justify-center`}><RowActionsCell row={row} onEdit={onEdit} /></div>;
    default:
      return null;
  }
}

export default function StlmPage() {
  const [stlmRows, setStlmRows] = useState<StlmRow[]>([]);
  // The real Balance Shop Agent roster — sourced from Opening Balance's own
  // "Opening AG" sheet (same data /api/opening feeds app/summary/page.tsx),
  // not from today's Settlement rows. Settlement only ever sees agents who
  // already had a transaction today; Opening has the full ~3,486-agent list,
  // so a brand-new/rarely-active agent still resolves correctly here.
  const [openingAgentNames, setOpeningAgentNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  // Lifted from DataTable.ScrollArea's own scroll listener so SettlementSummary
  // (which sits above <main>, outside that component's children) can show the
  // same "shadow while scrolling" the table's own sticky column header uses.
  const [tableScrolled, setTableScrolled] = useState(false);
  // SettlementSummary's KPI row — real counts/totals computed in fetchData
  // from the SAME "AG BD STLM + TOPUP" sheet the table itself reads (it
  // carries several weeks of rows, not just today's; isToday()/isYesterday()
  // narrow it down). Not derived from stlmRows itself, since that's already
  // narrowed to today only — see fetchData for the actual computation.
  const [kpiStats, setKpiStats] = useState<SettlementKpiStats>(EMPTY_KPI_STATS);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn>('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  // Row Actions -> Edit (UI-only prototype, no persistence — see
  // RecordFormModal). Holds the row being edited; null means the modal is
  // closed.
  const [editingRow, setEditingRow] = useState<StlmRow | null>(null);
  // "+ Add" dropdown -> New Record / Bulk Import (both UI-only prototypes,
  // same precedent as Edit above — see RecordFormModal/BulkImportModal).
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  // Checkbox row selection (keyed by StlmRow._id, see its own comment) —
  // persists across sort/search/pagination by design; only cleared by
  // Clear Selection or a fresh fetchData (see there). Reusable base for
  // any future bulk action beyond Bulk Edit (Delete Selected, Export
  // Selected, etc.) — nothing about this state is Bulk-Edit-specific.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  // Mirrors `selectedIds.size > 0` — swaps the toolbar between the "{N}
  // Selected"/Bulk Edit cluster and the Add button.
  const [selectionBarRendered, setSelectionBarRendered] = useState(false);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  // Column Visibility (Enterprise Table V2, Sprint 1) — persisted the same
  // way Sidebar persists its own panel state: read once on mount (gated by
  // `mounted` so the write-effect below can't fire during the initial
  // render and clobber a saved value back to the all-visible default),
  // written on every change thereafter.
  const [columnDefs, setColumnDefs] = useState<ColumnDef[]>(DEFAULT_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [columnsMenuPos, setColumnsMenuPos] = useState({ top: 0, left: 0 });
  const [mounted, setMounted] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);
  const columnsMenuRef = useRef<HTMLDivElement>(null);
  // Keeps the portal mounted for 150ms after close so the closing
  // opacity/scale transition (driven by columnsMenuOpen below) can play
  // before React unmounts it — same pattern as Balance's Columns menu.
  const [columnsMenuRendered, setColumnsMenuRendered] = useState(false);
  useEffect(() => {
    if (columnsMenuOpen) {
      setColumnsMenuRendered(true);
    } else {
      const timeout = setTimeout(() => setColumnsMenuRendered(false), 150);
      return () => clearTimeout(timeout);
    }
  }, [columnsMenuOpen]);

  useEffect(() => {
    setMounted(true);
    const saved = getPreference<Record<string, boolean> | null>(COLUMN_VISIBILITY_STORAGE_KEY, null);
    if (!saved) return;
    setColumnDefs((current) =>
      current.map((col) => (col.id in saved ? { ...col, visible: saved[col.id] } : col))
    );
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const visibility = Object.fromEntries(columnDefs.map((col) => [col.id, col.visible])) as Record<ColumnKey, boolean>;
    setPreference(COLUMN_VISIBILITY_STORAGE_KEY, visibility);
  }, [columnDefs, mounted]);

  useEffect(() => {
    if (!columnsMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        columnsButtonRef.current && !columnsButtonRef.current.contains(target) &&
        columnsMenuRef.current && !columnsMenuRef.current.contains(target)
      ) {
        setColumnsMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setColumnsMenuOpen(false);
        columnsButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [columnsMenuOpen]);

  // The popover portals to document.body, at the end of the DOM — outside
  // natural Tab order from the trigger button, which lives deep inside the
  // page's own tree. Moving focus to the first checkbox on open (after the
  // portal has actually mounted, hence the effect rather than doing this
  // inline) is what makes Tab/Space actually reach it, instead of Tab
  // skipping past the portal entirely to whatever the next focusable
  // element happens to be in the page's own layout.
  useEffect(() => {
    if (!columnsMenuOpen) return;
    const firstControl = columnsMenuRef.current?.querySelector<HTMLElement>('input, button');
    firstControl?.focus();
  }, [columnsMenuOpen]);

  // Gated on `mounted` so the very first paint never shows the all-visible
  // DEFAULT_COLUMNS set before the saved preference has been read (Sprint 1's
  // mount-then-read pattern otherwise briefly paints 7 columns, then snaps
  // down to however many are actually saved — a real, measured layout shift
  // on every reload where columns are hidden). Pre-mount, this renders zero
  // columns instead — matches server-rendered markup exactly (no hydration
  // mismatch) and settles once, straight to the correct final count.
  const visibleColumns = useMemo(
    () => (mounted ? columnDefs : []).filter((col) => col.visible),
    [columnDefs, mounted]
  );
  const visibleHideableCount = useMemo(
    () => columnDefs.filter((col) => col.hideable && col.visible).length,
    [columnDefs]
  );

  // Sizing engine (renderer-agnostic) -> renderer translation (Flex, this
  // page's own choice), each recomputed once per visibility change rather
  // than once per cell as columnFlexStyle used to be — an incidental perf
  // win, not a requirement, from separating "what are this column's sizing
  // fields" (calculateColumnLayout) from "what CSS does that become"
  // (toFlexColumnStyle). Render functions receive the resolved style
  // directly and never see ColumnLayout or know Flex exists.
  const columnLayout = useMemo(() => calculateColumnLayout(visibleColumns), [visibleColumns]);
  // Each column now carries a real CSS minWidth + flexShrink:1 (see
  // toFlexColumnStyle), so the browser's own flex algorithm distributes any
  // squeeze across every column at once instead of one column (Brand) being
  // singled out for a manual calc() floor. The 44px checkbox column is a
  // separate fixed-width, flex-shrink:0 sibling in the row JSX below — it
  // never shrinks, so it doesn't need any special accounting here; the
  // other columns simply shrink to make room for it like any other flex
  // item competing for space.
  const flexStyleById = useMemo(
    () => Object.fromEntries(
      columnLayout.map((layout) => [layout.id, toFlexColumnStyle(layout)])
    ) as Record<ColumnKey, CSSProperties>,
    [columnLayout]
  );

  // Skeleton -> table is a real two-step cross-fade, not an instant swap:
  // once data arrives, the skeleton fades OUT in place (same DOM node, so
  // the opacity transition actually plays) for 120ms, then gets replaced by
  // the real rows, which fade IN over 200ms. Refreshing (loading flips back
  // true) snaps straight back to the skeleton — only the appearance of data
  // needs the soft landing.
  const [rowsPhase, setRowsPhase] = useState<'skeleton' | 'fadingOut' | 'table'>('skeleton');

  useEffect(() => {
    if (loading) {
      setRowsPhase('skeleton');
      return;
    }
    setRowsPhase('fadingOut');
    const timer = setTimeout(() => setRowsPhase('table'), 120);
    return () => clearTimeout(timer);
  }, [loading]);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      const [res, balRes, openingRes] = await Promise.all([
        fetch(`/api/agstlmtopup?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
        fetch(`/api/opening?t=${Date.now()}`),
      ]);
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Request failed with status ${res.status}`);
      const text = await res.text();
      const balText = balRes.ok ? await balRes.text() : '';
      const openingText = openingRes.ok ? await openingRes.text() : '';

      // Agent Name roster — col A of "Opening AG" (same column
      // app/summary/page.tsx reads for its own Agent Name), the real
      // Balance Shop master list rather than a today-only stand-in.
      const openingNames = new Set<string>();
      openingText.trim().split('\n').slice(1).forEach(line => {
        const name = rawVal(line.split(',')[0]);
        // Uppercased before adding — the real table always displays Agent
        // Name via .toUpperCase() (see renderCell below), so the roster
        // feeding Add/Edit's combobox and Bulk Import's validation should
        // match that same canonical casing regardless of how the sheet
        // itself has it stored.
        if (name && name !== '-' && name !== 'OLD') openingNames.add(name.toUpperCase());
      });
      setOpeningAgentNames(Array.from(openingNames).sort((a, b) => a.localeCompare(b)));

      // Brand cross-reference: "SSP AG BalanceLimit" col G (index 6) is the
      // Group text; same computeBrand/resolveBrand priority logic as
      // Cashout's own Agent Balance page, keyed by the bare wallet name.
      const brandGroups: Record<string, string[]> = {};
      if (balText) {
        balText.trim().split('\n').slice(1).forEach(line => {
          const cols = line.split(',');
          const name = rawVal(cols[1]);
          const group = rawVal(cols[6]);
          if (name && group && group !== '-') {
            (brandGroups[name.toUpperCase()] ??= []).push(group);
          }
        });
      }

      const lines = text.trim().split('\n').slice(1);

      const stlm: StlmRow[] = [];

      // One canonical brand per shop, not per row — if ANY of a shop's
      // Settlement rows carries an explicit suffix/alt-format brand marker,
      // that's authoritative for every one of its rows (a shop's brand
      // doesn't change transaction to transaction); only shops that never
      // carry one anywhere fall back to the "SSP AG BalanceLimit"
      // cross-reference. Resolving this per-shop first (not independently
      // per row) is what keeps a shop's brand consistent across its own
      // multiple Settlement entries — same fix already applied to
      // app/topup/page.tsx and app/page.tsx's SSP Line 1 table after the
      // same inconsistency was reported there (one shop showing two
      // different brands across its own rows).
      const agentBrandOverride: Record<string, string> = {};
      lines
        .filter(line => line.trim() !== '')
        .forEach(line => {
          const cols = line.split(',');
          const agentRight = rawVal(cols[7]);
          if (!agentRight || agentRight === '-' || agentRight === '0') return;
          const marker = extractBrandSuffix(agentRight) ?? extractBrandAltFormat(agentRight);
          if (marker) {
            agentBrandOverride[stripBrandSuffix(agentRight).toUpperCase()] = marker;
          }
        });

      // "AG BD STLM + TOPUP" is Cashout's own dedicated Settlement + Top Up
      // sheet (replaces the old shared "Stlm Top Up" source). Settlement
      // lives in cols H-L (indices 7-11): To Agent/Amount/Date/Wallet/Type
      // (the sheet's own header row mislabels cols D/E as "Wallet"/"Date" —
      // the actual data order matches this, confirmed by sampling), amounts
      // stored negative (money leaving) so they're abs()'d. Cols B-F are a
      // separate Top Up block (see app/topup/page.tsx) and cols Q-AA are a
      // last-month archive — neither belongs here.
      lines
        .filter(line => line.trim() !== '')
        .forEach(line => {
          const cols = line.split(',');
          const agentRight = rawVal(cols[7]);
          if (agentRight && agentRight !== '-' && agentRight !== '0') {
            const bareAgent = stripBrandSuffix(agentRight);
            const bareAgentKey = bareAgent.toUpperCase();
            stlm.push({
              agentName: bareAgent,
              amount: String(Math.abs(parseAmount(rawVal(cols[8])))),
              remarks: rawVal(cols[11]),
              date: rawVal(cols[9]),
              wallet: rawVal(cols[10]),
              brand: agentBrandOverride[bareAgentKey] ?? resolveBrand(brandGroups[bareAgentKey] ?? [], agentRight),
              _id: stlm.length,
            });
          }
        });

      // Same validity filter as before, split out so both the table's
      // "today only" rows and the KPI row's "today vs yesterday" comparison
      // can be computed from one pass over the full (unfiltered-by-date)
      // sheet, instead of the table's own isToday() filter discarding
      // yesterday's rows before the KPI row ever gets a chance to see them.
      const validStlm = stlm.filter(row => row.agentName && row.agentName !== '-' && row.agentName !== '0');
      const todayStlm = validStlm.filter(row => isToday(row.date));
      const yesterdayStlm = validStlm.filter(row => isYesterday(row.date));

      setStlmRows(todayStlm);
      // A fresh fetch means brand-new row objects (and _ids reset to 0..N)
      // — any previous selection no longer refers to anything real, so it
      // clears here rather than silently pointing at the wrong rows.
      setSelectedIds(new Set());
      setKpiStats({
        todayCount: todayStlm.length,
        todayAmount: todayStlm.reduce((sum, row) => sum + parseAmount(row.amount), 0),
        yesterdayCount: yesterdayStlm.length,
        yesterdayAmount: yesterdayStlm.reduce((sum, row) => sum + parseAmount(row.amount), 0),
      });
    } catch (err) {
      setError(classifyFetchError(err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
      setSpinning(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    setPage(1);
  }, [searchTerm, sortColumn, sortDirection, rowsPerPage]);

  const searchedRows = stlmRows.filter((row) => {
    const haystack = `${row.agentName} ${row.amount} ${row.remarks} ${row.date} ${row.wallet} ${row.brand}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  const sortedRows = useMemo(() => {
    if (!sortColumn) return searchedRows;
    const list = [...searchedRows];
    list.sort((a, b) => {
      const getValue = (row: StlmRow) => {
        switch (sortColumn) {
          case COLUMN_IDS.BRAND:
            return row.brand.toLowerCase();
          case COLUMN_IDS.AGENT_NAME:
            return row.agentName.toLowerCase();
          case COLUMN_IDS.WALLET:
            return row.wallet.toLowerCase();
          case COLUMN_IDS.AMOUNT:
            return parseAmount(row.amount);
          case COLUMN_IDS.REMARKS:
            return row.remarks.toLowerCase();
          case COLUMN_IDS.DATE:
            return row.date.toLowerCase();
          default:
            return '';
        }
      };

      const valueA = getValue(a);
      const valueB = getValue(b);

      if (typeof valueA === 'string' || typeof valueB === 'string') {
        const comparison = String(valueA).localeCompare(String(valueB));
        return sortDirection === 'asc' ? comparison : -comparison;
      }

      const comparison = (valueA as number) - (valueB as number);
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [searchedRows, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const pagedRows = sortedRows.slice(startIndex, endIndex);

  // Header checkbox only ever acts on the CURRENT page's rows (per spec),
  // even though selectedIds itself can hold ids from other pages too.
  const pageRowIds = pagedRows.map((row) => row._id);
  const selectedOnPageCount = pageRowIds.filter((id) => selectedIds.has(id)).length;
  const allOnPageSelected = pageRowIds.length > 0 && selectedOnPageCount === pageRowIds.length;


  // Swaps back to the Add button the instant selectedIds hits 0 — no exit
  // delay. An earlier version held the "{N} Selected"/Bulk Edit cluster
  // rendered for 150ms after reaching 0 so its own fade-out could play, but
  // that read as a stale "0 Selected" catching the user's eye right after
  // they'd already cleared the selection — worse than an instant swap.
  useEffect(() => {
    setSelectionBarRendered(selectedIds.size > 0);
  }, [selectedIds.size]);

  const toggleRowSelection = useCallback((id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAllOnPage = useCallback(() => {
    if (allOnPageSelected) {
      // Same fast full reset the old "Clear Selection" button used — a
      // plain setSelectedIds(new Set()), instead of copying the existing
      // Set and deleting this page's ids out of it one by one, which is
      // what made unchecking via the header checkbox feel noticeably
      // slower (a visible "0 Selected" lag) than the button was.
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      pageRowIds.forEach((id) => next.add(id));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allOnPageSelected, pageRowIds.join(',')]);

  // Reverses DateInput's own "Jul 24, 2026" display format back into this
  // page's raw "M/D/YYYY" row storage convention — mirrors the same
  // conversion BulkImportModal's Edit Row dialog already does.
  const parseDisplayDateToStorage = (display: string): string => {
    const parsed = new Date(display);
    if (isNaN(parsed.getTime())) return display;
    return `${parsed.getMonth() + 1}/${parsed.getDate()}/${parsed.getFullYear()}`;
  };

  const handleBulkEditApply = useCallback((updates: BulkEditUpdates) => {
    setStlmRows((current) => current.map((row) => {
      if (!selectedIds.has(row._id)) return row;
      return {
        ...row,
        ...(updates.wallet !== undefined ? { wallet: updates.wallet } : {}),
        ...(updates.remarks !== undefined ? { remarks: updates.remarks } : {}),
        ...(updates.date !== undefined ? { date: parseDisplayDateToStorage(updates.date) } : {}),
      };
    }));
    setBulkEditOpen(false);
    setSelectedIds(new Set());
  }, [selectedIds]);

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  const settlementRecordFields: RecordFormField[] = useMemo(() => [
    { key: 'brand', label: 'Brand', kind: 'combobox', options: SETTLEMENT_BRAND_OPTIONS, required: true },
    { key: 'agentName', label: 'Agent Name', kind: 'combobox', options: openingAgentNames, required: true },
    { key: 'wallet', label: 'Wallet', kind: 'combobox', options: CASHOUT_WALLET_OPTIONS, required: true },
    { key: 'amount', label: 'Amount', kind: 'amount', required: true },
    { key: 'remarks', label: 'Remarks', kind: 'combobox', options: SETTLEMENT_REMARKS_SUGGESTIONS, allowCustom: true },
    { key: 'date', label: 'Date', kind: 'date', required: true },
  ], [openingAgentNames]);

  const handleExport = useCallback(() => {
    const getExportValue = (row: StlmRow, key: ColumnKey) => {
      switch (key) {
        case COLUMN_IDS.BRAND:
          return row.brand;
        case COLUMN_IDS.AGENT_NAME:
          return row.agentName;
        case COLUMN_IDS.WALLET:
          return row.wallet;
        case COLUMN_IDS.AMOUNT:
          return displayNum(row.amount);
        case COLUMN_IDS.REMARKS:
          return row.remarks;
        case COLUMN_IDS.DATE:
          return row.date;
        default:
          return '';
      }
    };

    const exportColumns = visibleColumns.filter((col) => col.id !== COLUMN_IDS.ACTIONS);
    const headers = exportColumns.map((col) => col.label);
    const data = sortedRows.map((row) => exportColumns.map((col) => getExportValue(row, col.id)));

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Settlement');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SSP1_SETTLEMENT_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  // Clears the free-text search — the "Clear Search" action on the
  // No-Search-Results state.
  const clearSearch = useCallback(() => {
    setSearchTerm('');
  }, []);

  const handlePageSizeChange = useCallback((size: number) => {
    setRowsPerPage(size);
  }, []);

  // Genuinely-no-data (stlmRows itself is empty) vs a search/filter that
  // just happens to return nothing are different states with different
  // copy, icon, and action — computed once here, reused by both the
  // desktop and mobile empty-state renders below. Deliberately keyed off
  // stlmRows (the unfiltered set), not sortedRows, so an active search that
  // returns zero rows out of a real dataset never gets mistaken for "no
  // records exist at all."
  // Balance-style KPI cards (bespoke, not SettlementSummary — that component
  // is shared with the 3 Send Money equivalent pages, which weren't part of
  // this redesign). Count metrics have no subtitle (would just duplicate the
  // big value); amount metrics get an abbreviated big value + full-figure
  // subtitle, matching Balance's Total DP/Total WD pattern exactly.
  const kpis = useMemo(() => [
    {
      label: "Today's Total Count", icon: Hash,
      accent: 'text-indigo-600 dark:text-indigo-400', iconBg: 'bg-indigo-50 dark:bg-indigo-500/10',
      bigValue: kpiStats.todayCount.toLocaleString('en-US'), subtitle: undefined as string | undefined,
    },
    {
      label: "Today's Total Amount", icon: Banknote,
      accent: 'text-emerald-600 dark:text-emerald-400', iconBg: 'bg-emerald-50 dark:bg-emerald-500/10',
      bigValue: fmtAbbrev(kpiStats.todayAmount), subtitle: fmt(kpiStats.todayAmount) as string | undefined,
    },
    {
      label: "Yesterday's Total Count", icon: Hash,
      accent: 'text-slate-500 dark:text-slate-400', iconBg: 'bg-slate-100 dark:bg-slate-500/10',
      bigValue: kpiStats.yesterdayCount.toLocaleString('en-US'), subtitle: undefined as string | undefined,
    },
    {
      label: "Yesterday's Total Amount", icon: Banknote,
      accent: 'text-orange-500 dark:text-orange-400', iconBg: 'bg-orange-50 dark:bg-orange-500/10',
      bigValue: fmtAbbrev(kpiStats.yesterdayAmount), subtitle: fmt(kpiStats.yesterdayAmount) as string | undefined,
    },
  ], [kpiStats]);

  const hasAnyRecords = stlmRows.length > 0;
  const emptyStateNode = !hasAnyRecords ? (
    <EmptyState
      icon={Inbox}
      title="No Settlement Records"
      description="Settlement records will appear here once they are created or imported."
      action={
        <button type="button" onClick={() => setNewRecordOpen(true)} className={EMPTY_STATE_PRIMARY_BUTTON}>
          Add Record
        </button>
      }
    />
  ) : (
    <EmptyState
      title="No matching settlement records."
      description="Try changing your search or filters."
      action={
        <button type="button" onClick={clearSearch} className={EMPTY_STATE_ACTION_BUTTON}>
          Clear Search
        </button>
      }
    />
  );

  return (
    <div
      className="h-screen w-full flex flex-col overflow-hidden bg-background text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]"
      style={{ fontFamily: 'var(--font-inter), ui-sans-serif, system-ui, sans-serif' }}
    >
      <SettlementHeader
        icon={ArrowLeftRight}
        title="Settlement"
        isRefreshing={spinning}
        onRefresh={fetchData}
      />
      <div className={`w-full border-t border-border bg-[#f4f6fb] px-4 py-3 transition-shadow duration-150 ease-out dark:bg-[#1c1c1e] md:px-6 ${tableScrolled ? TABLE_STICKY_HEADER_SHADOW_CLASS : ''}`}>
        <div className="flex gap-2">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-[80.5px] flex-1 min-w-[200px] rounded-xl border border-border bg-white p-2.5 dark:bg-[#2a2a2d]">
                <div className="flex h-full items-center gap-3">
                  <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-700" />
                  <div className="min-w-0 flex-1">
                    <div className="h-3 w-20 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="mt-1.5 h-6 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                </div>
              </div>
            ))
          ) : (
            kpis.map((kpi) => (
              <div
                key={kpi.label}
                className="h-[80.5px] flex-1 min-w-[200px] rounded-xl border border-border bg-white p-2.5 transition-[transform,box-shadow,border-color] duration-150 ease-out hover:-translate-y-px hover:border-foreground/20 hover:shadow-sm dark:bg-[#2a2a2d]"
              >
                <div className="flex h-full items-center gap-3">
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${kpi.iconBg}`}>
                    <kpi.icon size={16} className={kpi.accent} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium leading-snug text-muted-foreground truncate">{kpi.label}</p>
                    <FadeValue value={kpi.bigValue} className={`font-bold leading-tight text-foreground ${kpi.subtitle ? 'text-[21px]' : 'text-[28px]'}`} />
                    {kpi.subtitle && (
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground truncate">{kpi.subtitle}</p>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* pt-4 (16px) instead of the uniform p-6's 24px top — explicit
          breathing room between SettlementSummary and the toolbar below,
          tuned to spec (12-16px) rather than left at the larger default. */}
      <main className="flex-1 flex flex-col overflow-hidden px-6 pb-6 pt-1">

        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <DataTable>
            <Toolbar>
              <Toolbar.Left>
                <div className="flex h-10 w-full min-w-[200px] items-center gap-2 rounded-[10px] border border-[#E5E7EB] bg-white px-[14px] transition-colors focus-within:border-[#2563EB] focus-within:ring-2 focus-within:ring-[#2563EB]/20 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] sm:w-[380px]">
                  {loading ? (
                    <div className="dt-skeleton h-3 w-32 rounded-md" />
                  ) : (
                    <>
                      <Search size={16} className="shrink-0 text-[#94A3B8]" />
                      <input
                        aria-label="Search agent, wallet, or brand"
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        className="flex-1 bg-transparent text-[13px] font-normal text-[#111827] placeholder:text-[#94A3B8] outline-none border-none dark:text-[#E5E7EB]"
                        placeholder="Search agent, wallet, or brand..."
                      />
                    </>
                  )}
                </div>
              </Toolbar.Left>

              <Toolbar.Right>
                {loading && (
                  <>
                    <div className="dt-skeleton h-9 w-[76px] rounded-[8px]" />
                    <div className="dt-skeleton h-8 w-8 rounded-[8px]" />
                    <div className="dt-skeleton h-9 w-[88px] rounded-[8px]" />
                    <div className="dt-skeleton h-9 w-[104px] rounded-[8px]" />
                  </>
                )}
                {!loading && (
                  <>
                    {selectionBarRendered ? (
                      <div className="flex flex-wrap items-center gap-3 dt-bar-fade-in">
                        <span className="text-[13px] font-medium text-foreground">{selectedIds.size} Selected</span>
                        <button
                          type="button"
                          onClick={() => setBulkEditOpen(true)}
                          className="inline-flex h-9 items-center rounded-[8px] bg-indigo-600 px-3 text-[13px] font-medium text-white transition-colors hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]"
                        >
                          Bulk Edit
                        </button>
                      </div>
                    ) : (
                      <AddRecordDropdown
                        templateModule="settlement"
                        onNewRecord={() => setNewRecordOpen(true)}
                        onBulkImport={() => setBulkImportOpen(true)}
                        buttonClassName="bg-indigo-600 hover:bg-indigo-700"
                      />
                    )}
                    <button type="button" onClick={fetchData} aria-label="Refresh" title="Refresh" className={GHOST_BUTTON}>
                      <RefreshCw size={15} className={spinning ? 'animate-spin' : ''} />
                    </button>
                    <button type="button" onClick={handleExport} aria-label="Export to Excel" title="Export to Excel" className={GHOST_BUTTON}>
                      <Download size={15} />
                      Export
                    </button>
                    <div className="relative">
                      <button
                        type="button"
                        ref={columnsButtonRef}
                        onClick={(event) => {
                          event.stopPropagation();
                          const rect = columnsButtonRef.current?.getBoundingClientRect();
                          if (rect) {
                            const dropdownWidth = 224;
                            const left = Math.max(8, Math.min(rect.right - dropdownWidth, window.innerWidth - dropdownWidth - 8));
                            setColumnsMenuPos({ top: rect.bottom + 8, left });
                          }
                          setColumnsMenuOpen((current) => !current);
                        }}
                        aria-haspopup="true"
                        aria-expanded={columnsMenuOpen}
                        aria-controls="settlement-columns-popover"
                        aria-label="Columns"
                        title="Columns"
                        className={GHOST_BUTTON}
                      >
                        <Columns3 size={15} />
                        Columns
                      </button>
                      {columnsMenuRendered && typeof document !== 'undefined' && createPortal(
                        <div
                          ref={columnsMenuRef}
                          id="settlement-columns-popover"
                          role="dialog"
                          aria-label="Column visibility"
                          style={{ position: 'fixed', top: columnsMenuPos.top, left: columnsMenuPos.left, transformOrigin: 'top right' }}
                          className={`z-[9999] w-56 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl transition-[transform,opacity] duration-150 ease-[var(--ease-out-strong)] dark:border-[#3a3a3d] dark:bg-[#2a2a2d] ${
                            columnsMenuOpen ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
                          }`}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.stopPropagation();
                              setColumnsMenuOpen(false);
                              columnsButtonRef.current?.focus();
                            }
                          }}
                        >
                          <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">
                            Columns
                          </div>
                          <div className="max-h-64 overflow-y-auto">
                            {columnDefs.filter((col) => col.hideable).map((col) => {
                              // At least one data column must stay visible —
                              // hiding all of them leaves only the
                              // non-hideable Actions column, an unusable
                              // table with no data and nothing to export.
                              // Disable (rather than silently no-op) the
                              // last remaining visible column's checkbox so
                              // this reads as an intentional floor, not a
                              // broken click.
                              const isLastVisible = col.visible && visibleHideableCount === 1;
                              return (
                                <label
                                  key={col.id}
                                  title={isLastVisible ? 'At least one column must stay visible' : undefined}
                                  className={`flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[13px] font-normal ${
                                    isLastVisible
                                      ? 'cursor-not-allowed text-[#94A3B8] dark:text-[#6b7280]'
                                      : 'text-[#475569] hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={col.visible}
                                    disabled={isLastVisible}
                                    onChange={() => {
                                      setColumnDefs((current) =>
                                        current.map((c) => (c.id === col.id ? { ...c, visible: !c.visible } : c))
                                      );
                                    }}
                                  />
                                  <span>{col.label}</span>
                                </label>
                              );
                            })}
                          </div>
                          <div className="mt-1 border-t border-[#F1F5F9] pt-1 dark:border-[#2f2f32]">
                            <button
                              type="button"
                              onClick={() => setColumnDefs(DEFAULT_COLUMNS.map((col) => ({ ...col })))}
                              className="flex w-full items-center justify-center rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[#2563EB] transition-[background-color,transform] duration-150 ease-[var(--ease-out-strong)] hover:bg-[#EFF6FF] active:scale-[0.97] dark:hover:bg-white/5"
                            >
                              Restore Defaults
                            </button>
                          </div>
                        </div>,
                        document.body
                      )}
                    </div>
                  </>
                )}
              </Toolbar.Right>
            </Toolbar>
            {/* 6px breathing room above the table's sticky column header —
                page-local spacer, not a change to Toolbar/DataTable's own
                shared internals (both stay untouched for every other
                consumer). Desktop only, matching the table header this is
                separating from; the mobile card list below has no such
                header to separate from. */}
            <div className="hidden h-1.5 shrink-0 sm:block" />
            <DataTable.ScrollArea className="hidden sm:block" onScrolledChange={setTableScrolled}>
              {(isScrolled) => (
                <>
                  <DataTable.StickyHeader isScrolled={isScrolled}>
                  <div role="row" className="flex h-[48px] items-center">
                    <div role="columnheader" className="flex h-full w-[44px] shrink-0 items-center justify-center">
                      <input
                        type="checkbox"
                        aria-label="Select all rows on this page"
                        checked={allOnPageSelected}
                        onChange={toggleSelectAllOnPage}
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                    </div>
                    {visibleColumns.map((col) => (
                      <div
                        key={col.id}
                        role="columnheader"
                        style={flexStyleById[col.id]}
                        aria-sort={!col.sortable ? undefined : sortColumn === col.id ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                        className={headerCellClasses(col.id !== COLUMN_IDS.BRAND && sortColumn === col.id, col.id === COLUMN_IDS.BRAND, COLUMN_ALIGN[col.id], 'px-4')}>
                        {/* Header always renders its real label/sort control,
                            loading or not — only data rows shimmer (premium
                            skeleton spec: headers are never placeholders). */}
                        {!col.sortable ? (
                          <span>{col.label}</span>
                        ) : (
                          <button
                            type="button"
                            aria-label={`Sort by ${col.label}${sortColumn === col.id ? (sortDirection === 'asc' ? ', ascending' : ', descending') : ''}`}
                            onClick={() => {
                              if (sortColumn === col.id) {
                                setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
                              } else {
                                setSortColumn(col.id as SortColumn);
                                setSortDirection('asc');
                              }
                            }}
                            className={`relative flex w-full items-center gap-1.5 text-${COLUMN_ALIGN[col.id]} transition-[color,transform] duration-150 ease-[var(--ease-out-strong)] hover:text-[#111827] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:hover:text-white ${
                              COLUMN_ALIGN[col.id] === 'right' ? 'justify-end' : COLUMN_ALIGN[col.id] === 'center' ? 'justify-center' : 'justify-start'
                            }`}
                          >
                            {COLUMN_ALIGN[col.id] === 'center' ? (
                              // Any center-aligned column (Brand, as of
                              // Sprint 3.4 — was Wallet before its
                              // alignment moved to left) needs this same
                              // treatment: the label sits in its own
                              // relatively-positioned wrapper sized to its
                              // own text only, so the button's
                              // justify-center centers that wrapper (i.e.
                              // the label alone). The icon is pulled out
                              // with position:absolute so it never
                              // contributes to the wrapper's width — it
                              // can't drag the centered label off-center no
                              // matter what glyph it shows. Keyed on
                              // alignment rather than a specific column id
                              // so this keeps working if alignment is
                              // retuned again.
                              <span className="relative inline-flex items-center">
                                {col.label}
                                <span className="absolute left-full ml-1.5 flex items-center">
                                  <SortIcon active={sortColumn === col.id} direction={sortDirection} />
                                </span>
                              </span>
                            ) : (
                              <>
                                {/* Icon always trails the label, on the
                                    right — reads as "Date ↕", never "↕
                                    Date". Remarks is already icon-
                                    independent this way: the label anchors
                                    to the container's start, so a trailing
                                    sibling never moves
                                    it — verified, no absolute positioning
                                    needed here. */}
                                <span>{col.label}</span>
                                <SortIcon active={sortColumn === col.id} direction={sortDirection} />
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  </DataTable.StickyHeader>
                <div
                  key={rowsPhase === 'table' ? 'data' : 'skeleton'}
                  role="rowgroup"
                  className={rowsPhase === 'fadingOut' ? 'dt-fade-out' : 'dt-fade-in'}
                >
                  {rowsPhase !== 'table' ? Array.from({ length: 11 }).map((_, i) => (
                    <div
                      key={i}
                      role="row"
                      className="flex h-[52px] items-center border-b border-[#ECEFF3] last:border-0 dark:border-[#2f2f32]"
                    >
                      <div className="h-full w-[44px] shrink-0" />
                      {visibleColumns.map((col) => renderSkeletonCell(col, i, flexStyleById[col.id]))}
                    </div>
                  )) : pagedRows.length > 0 ? pagedRows.map((row, i) => {
                    const isChecked = selectedIds.has(row._id);
                    return (
                      <div
                        key={i}
                        tabIndex={0}
                        role="row"
                        onClick={() => toggleRowSelection(row._id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            toggleRowSelection(row._id);
                          }
                        }}
                        aria-selected={isChecked}
                        className={`flex h-[52px] items-center cursor-pointer border-b border-[#ECEFF3] last:border-0 dark:border-[#2f2f32] transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#2563EB] ${
                          isChecked
                            ? 'bg-[color:var(--product-accent-soft)]'
                            : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.025]'
                        }`}
                      >
                        <div
                          role="cell"
                          className="flex h-full w-[44px] shrink-0 items-center justify-center"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select row for ${row.agentName}`}
                            checked={isChecked}
                            onChange={() => toggleRowSelection(row._id)}
                            className="h-3.5 w-3.5 cursor-pointer"
                          />
                        </div>
                        {visibleColumns.map((col) => renderCell(row, col, flexStyleById[col.id], setEditingRow, searchTerm))}
                      </div>
                    );
                  }) : rowsPhase === 'table' && (
                    <div role="row">
                      <div role="cell">
                        {emptyStateNode}
                      </div>
                    </div>
                  )}
                </div>
                </>
              )}
            </DataTable.ScrollArea>

            <div className="flex-1 min-h-0 overflow-y-auto sm:hidden">
              <div className="flex flex-col gap-2 p-3">
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="rounded-xl border border-border bg-white p-3.5 dark:bg-[#2a2a2d]">
                      <div className="h-4 w-2/3 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="mt-2 h-3 w-1/3 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="mt-3 h-6 w-1/2 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    </div>
                  ))
                ) : pagedRows.length > 0 ? (
                  pagedRows.map((row, i) => (
                    <div key={i} className="rounded-xl border border-border bg-white p-3.5 dark:bg-[#2a2a2d]">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-foreground">{row.agentName.toUpperCase()}</p>
                          <p className="truncate text-[12px] font-normal text-muted-foreground">{row.brand} · {toProperCase(row.wallet)}</p>
                        </div>
                        <span className="shrink-0 text-[12px] font-normal text-muted-foreground">{formatDateDisplay(row.date)}</span>
                      </div>

                      <div className="mt-2.5 flex items-baseline justify-between border-t border-border pt-2.5">
                        <span className="text-[11px] font-normal text-muted-foreground">{row.remarks}</span>
                        <span className="text-lg font-bold tabular-nums text-foreground">{displayNum(row.amount)}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  emptyStateNode
                )}
              </div>
            </div>

            {!loading && (
              <TableFooter
                recordCountText={
                  sortedRows.length === 0
                    ? 'Showing 0 of 0 Records'
                    : `Showing ${startIndex + 1}–${Math.min(endIndex, sortedRows.length)} of ${sortedRows.length} Records`
                }
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={setPage}
                pageSize={rowsPerPage}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageSizeChange={handlePageSizeChange}
                totalRecords={sortedRows.length}
                variant="premium"
              />
            )}
          </DataTable>
        )}
      </main>

      <RecordFormModal
        isOpen={editingRow !== null}
        onClose={() => setEditingRow(null)}
        title="Edit Settlement Record"
        fields={settlementRecordFields}
        initialValues={editingRow ? {
          brand: editingRow.brand,
          // Uppercase, not toProperCase — Agent Name's canonical form is
          // full caps (matches the live table's own .toUpperCase()
          // display), unlike Wallet below which really is Title Case.
          agentName: editingRow.agentName.toUpperCase(),
          wallet: toProperCase(editingRow.wallet),
          amount: String(parseAmount(editingRow.amount)),
          remarks: editingRow.remarks,
          date: formatDateDisplay(editingRow.date),
        } : {}}
        primaryButtonClassName="bg-indigo-600 hover:bg-indigo-700"
      />

      <RecordFormModal
        isOpen={newRecordOpen}
        onClose={() => setNewRecordOpen(false)}
        title="New Settlement Record"
        fields={settlementRecordFields}
        initialValues={{}}
        primaryButtonClassName="bg-indigo-600 hover:bg-indigo-700"
      />

      <BulkImportModal
        isOpen={bulkImportOpen}
        onClose={() => setBulkImportOpen(false)}
        moduleLabel="Settlement Records"
        templateModule="settlement"
        accentButtonClassName="bg-indigo-600 hover:bg-indigo-700"
        brandOptions={SETTLEMENT_BRAND_OPTIONS}
        walletOptions={CASHOUT_WALLET_OPTIONS}
        agentRoster={openingAgentNames}
        remarksSuggestions={SETTLEMENT_REMARKS_SUGGESTIONS}
      />

      <BulkEditModal
        isOpen={bulkEditOpen}
        onClose={() => setBulkEditOpen(false)}
        onApply={handleBulkEditApply}
        selectedCount={selectedIds.size}
        walletOptions={CASHOUT_WALLET_OPTIONS}
        remarksSuggestions={SETTLEMENT_REMARKS_SUGGESTIONS}
        primaryButtonClassName="bg-indigo-600 hover:bg-indigo-700"
      />
    </div>
  );
}
