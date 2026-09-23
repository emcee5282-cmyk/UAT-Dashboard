'use client';

// Direct port of daily-txn-entry.html (the design/behavior reference) onto
// this app's own shell (PageHeader, dd-page token scope copied from
// app/page.tsx — see the long comment there on why --dd-pos/--dd-neg/
// --ink-*/--hair are defined locally per page instead of globally). Data is
// hardcoded from the reference file's own seed values — no backend wiring
// yet (see NOTE below), per explicit scope: state lives only in this page,
// lost on refresh, until a persistence layer is requested.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Manrope, Space_Grotesk } from 'next/font/google';
import { Moon, Pencil, Sun, TriangleAlert, Download, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import * as XLSX from 'xlsx';
import PageHeader from '@/app/components/PageHeader';
import AccountMenu from '@/app/components/AccountMenu';
import TableLoadingSpinner from '@/app/components/TableLoadingSpinner';
import DateRangeFilter from '@/app/components/DateRangeFilter';
import { useTheme } from '@/app/components/ThemeProvider';

// Explicit, scoped exception to this app's app-wide Inter rule — per
// explicit instruction, this page only: Manrope for UI text/labels/body
// copy, Space Grotesk for anything that reads as data/a number (applied via
// the .dd-page .tabular-nums rule below, since every numeric value on this
// page already carries that class). Every other page keeps Inter.
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk', display: 'swap' });

const BRANDS = ['M1', 'M2', 'K1', 'B1', 'B2', 'B3', 'B4', 'B5', 'T1', 'J1'] as const;
type Brand = (typeof BRANDS)[number];
type BrandMap = Partial<Record<Brand, number>>;
type LedgerKind = 'standard' | 'ess';

// Row keys as used by the reference file: standard ledgers key off
// opening/deposit/withdrawal/adjustment; ESS Gateway keys off its own
// dpBkash/dpNagad/wdBkash/wdNagad split instead of a single deposit/withdrawal.
type StandardRowKey = 'opening' | 'deposit' | 'withdrawal' | 'adjustment';
type EssRowKey = 'opening' | 'dpBkash' | 'dpNagad' | 'wdBkash' | 'wdNagad' | 'adjustment';
type RowKey = StandardRowKey | EssRowKey;

type LedgerMeta = {
  id: string;
  title: string;
  kind: LedgerKind;
};

// Which rows are user-editable, IN PASTE-DISTRIBUTION ORDER — a multi-row
// paste fills these rows in this exact sequence starting from the row the
// paste landed on. Ported verbatim from the reference file's EDITABLE_ROWS.
const EDITABLE_ROWS: Record<LedgerKind, RowKey[]> = {
  standard: ['deposit', 'withdrawal', 'adjustment'],
  ess: ['dpBkash', 'dpNagad', 'wdBkash', 'wdNagad', 'adjustment'],
};

const ROW_LABELS: Record<RowKey, string> = {
  opening: 'Opening Balance',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  dpBkash: 'DP · Bkash',
  dpNagad: 'DP · Nagad',
  wdBkash: 'WD · Bkash',
  wdNagad: 'WD · Nagad',
  adjustment: 'Adjustment',
};

// Ledger DEFINITIONS only (id/title/kind) — the actual per-brand row data
// now comes from GET /api/daily-txn-entry/ledger?ledgerId=X (see
// LedgerCard's own fetch effect below), not a hardcoded seed. Whoever
// supplies real starting data does so directly against the database, per
// the approved persistence plan — there is no bootstrap seed here anymore.
const LEDGERS: LedgerMeta[] = [
  { id: 'ssp1', title: 'SSP Line 1 · Cashout', kind: 'standard' },
  { id: 'ssp2', title: 'SSP Line 2 · Send Money', kind: 'standard' },
  { id: 'ess', title: 'ESS Gateway · Cashout & Sendmoney', kind: 'ess' },
  { id: 'atp', title: 'AUTOPAY Gateway · Cashout', kind: 'standard' },
  { id: 'expay', title: 'EXPAY Gateway · Cashout', kind: 'standard' },
  { id: 'hkpay', title: 'HKPAY Gateway · Cashout', kind: 'standard' },
];

// New "PG Balances" tab — a separate view (same page, pill-switch below the
// header) showing a Payment-Gateway-level rollup instead of the per-ledger
// entry grids above. Self-contained data now — GET/POST
// /api/daily-txn-entry/wallet-closing and .../pg-balance, entered directly
// in the Report tab, NOT derived from the Operations tab's ledgers (see
// dailyTxnWalletClosingEntry/dailyTxnPgBalanceEntry's schema.ts comments —
// confirmed explicitly during planning: different dimensions, no mapping).
const PG_WALLETS = ['Bkash', 'Nagad', 'Rocket', 'UPay'] as const;
type PgWallet = (typeof PG_WALLETS)[number];

type PgKey = 'autopay' | 'expay' | 'ssp1' | 'ssp2' | 'essPg' | 'hkpay';
const PG_KEYS: PgKey[] = ['autopay', 'expay', 'ssp1', 'ssp2', 'essPg', 'hkpay'];
const PG_LABELS: Record<PgKey, string> = {
  autopay: 'AUTOPAY',
  expay: 'EXPAY',
  ssp1: 'SSP Line1',
  ssp2: 'SSP Line 2',
  essPg: 'ESS',
  hkpay: 'HKPAY',
};

// Ported verbatim from the reference file's fmt() — parenthesized negatives,
// not a leading minus sign, matching this ledger's own accounting-style
// convention (deliberately distinct from app/lib/format.ts's fmt(), which
// this page does not use). Deviates from the reference file's own fmt() per
// explicit follow-up: plain signed minus, no parenthesized negatives, and
// negative values always render red wherever they appear (not just the
// columns the reference file happened to hardcode red).
function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "Last update" display format — MM/DD - HH:MM AM/PM, per explicit
// instruction (no year, 12-hour clock).
function formatLastUpdate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hours24 = date.getHours();
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = String(hours24 % 12 || 12).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} - ${hours12}:${minutes} ${ampm}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "YYYY-MM-DD" -> "September 12", parsed from the string's own components
// (never `new Date(dateStr)`, which reads as UTC midnight and can shift the
// displayed day depending on the reader's timezone).
function formatDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}`;
}

function daysBetween(fromDateStr: string, toDateStr: string): number {
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const [ty, tm, td] = toDateStr.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

// Report tab's PG Closing Balance is now Operations tab's Opening Balance
// source (per explicit instruction) — this tells the user how far back
// their last real PG-balance snapshot goes, since Deposit/Withdrawal still
// only get entered here in Operations tab, not in Report tab. Replaces the
// old static "Paste today's txn only" note with the actual catch-up range:
// still-current shows the original wording; a gap (even just yesterday)
// names the exact starting date instead of silently assuming "today only".
function computeCatchUpNote(pgBalanceAsOfDate: string | null, businessDate: string): string {
  if (pgBalanceAsOfDate === null) return 'No PG closing balance recorded yet — paste today’s txn only';
  const gapDays = daysBetween(pgBalanceAsOfDate, businessDate);
  if (gapDays <= 0) return 'Paste today’s txn only';
  if (gapDays === 1) return 'Paste txn from yesterday to today';
  return `Paste txn from ${formatDateLabel(pgBalanceAsOfDate)} to today`;
}

// Shared shimmering placeholder block for every card's loading state below —
// replaces the old plain "Loading X…" text with a skeleton matching that
// card's real layout, so the page doesn't visibly jump/reflow once the fetch
// resolves.
function SkeletonBar({ className = '' }: { className?: string }) {
  return <div className={`dt-skeleton rounded-md ${className}`} />;
}

// Hard ceiling on any amount entered on this page — 9,999,999,999.00, both
// directions (positive and negative). Per explicit follow-up, this must
// never rewrite/convert what the user typed or pasted down to the cap —
// it can only refuse to let a value go PAST it. Live typing (below) blocks
// the offending keystroke outright (reverting to the last accepted value);
// paste (see the three onCellPaste/onPaste handlers) skips writing that one
// out-of-range cell entirely, leaving whatever was already there untouched
// — either way the rest of a multi-row paste keeps filling normally.
const MAX_INPUT_VALUE = 9_999_999_999;

function exceedsMax(num: number): boolean {
  return Math.abs(num) > MAX_INPUT_VALUE;
}

// Live thousands-comma formatting as the user types (not just on paste/blur)
// — reformats the input's own displayed value in place and returns the
// parsed number for the caller's own state. Cursor position is preserved by
// distance-from-the-END of the string rather than from the start, since
// commas are only ever inserted to the LEFT of existing digits — the
// distance from the end never changes when a comma is added or removed.
// `data-last-valid`/`data-last-valid-num` (set here, and seeded at render
// time alongside each input's defaultValue) hold the last accepted state so
// an over-the-cap keystroke can be reverted rather than reformatted down.
function applyLiveCommaFormat(input: HTMLInputElement): number {
  const raw = input.value;
  const cursorFromEnd = raw.length - (input.selectionStart ?? raw.length);

  let value = raw.replace(/,/g, '');
  const negative = value.trim().startsWith('-');
  if (negative) value = value.replace('-', '');
  value = value.replace(/[^\d.]/g, '');
  const firstDot = value.indexOf('.');
  if (firstDot !== -1) {
    value = value.slice(0, firstDot + 1) + value.slice(firstDot + 1).replace(/\./g, '');
  }

  let num = value === '' || value === '.' ? 0 : parseFloat(value) * (negative ? -1 : 1);
  if (isNaN(num)) num = 0;

  if (exceedsMax(num)) {
    const revert = input.dataset.lastValid ?? '';
    input.value = revert;
    const pos = Math.max(0, revert.length - cursorFromEnd);
    input.setSelectionRange(pos, pos);
    return Number(input.dataset.lastValidNum ?? '0');
  }

  const [intPart, decPart] = value.split('.');
  let formatted = intPart ? Number(intPart).toLocaleString('en-US') : '';
  if (decPart !== undefined) formatted += `.${decPart}`;
  if (negative && formatted !== '') formatted = `-${formatted}`;

  input.value = formatted;
  input.dataset.lastValid = formatted;
  input.dataset.lastValidNum = String(num);
  const newPos = Math.max(0, formatted.length - cursorFromEnd);
  input.setSelectionRange(newPos, newPos);

  return num;
}

// Ported verbatim from the reference file's parseNum() — bug-fixed through
// several rounds there: parentheses-as-negative, comma-as-thousands (never
// a delimiter), strip everything else.
function parseNum(raw: string): number {
  const trimmed = raw.trim();
  const isParenNeg = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[()]/g, '').replace(/,/g, '').replace(/[^\d.-]/g, '');
  let num = parseFloat(cleaned);
  if (isNaN(num)) num = 0;
  if (isParenNeg) num = -Math.abs(num);
  return num;
}

function getVal(rows: Partial<Record<RowKey, BrandMap>>, row: RowKey, brand: Brand): number {
  const v = rows[row]?.[brand];
  return v === undefined || v === null ? 0 : v;
}

function sumRow(rows: Partial<Record<RowKey, BrandMap>>, row: RowKey): number {
  return BRANDS.reduce((s, b) => s + getVal(rows, row, b), 0);
}

function computeTotal(rows: Partial<Record<RowKey, BrandMap>>, kind: LedgerKind, brand: Brand): number {
  if (kind === 'ess') {
    return (
      getVal(rows, 'opening', brand) +
      getVal(rows, 'dpBkash', brand) +
      getVal(rows, 'dpNagad', brand) -
      getVal(rows, 'wdBkash', brand) -
      getVal(rows, 'wdNagad', brand) +
      getVal(rows, 'adjustment', brand)
    );
  }
  return (
    getVal(rows, 'opening', brand) +
    getVal(rows, 'deposit', brand) -
    getVal(rows, 'withdrawal', brand) +
    getVal(rows, 'adjustment', brand)
  );
}

function sumTotals(rows: Partial<Record<RowKey, BrandMap>>, kind: LedgerKind): number {
  return BRANDS.reduce((s, b) => s + computeTotal(rows, kind, b), 0);
}

function LedgerCard({ def, onActivity }: { def: LedgerMeta; onActivity: () => void }) {
  const isEss = def.kind === 'ess';
  // Starts empty and is populated by the fetch effect below (GET
  // /api/daily-txn-entry/ledger) — real React state (not a ref) so render
  // can read it directly; the inputs themselves stay uncontrolled
  // (defaultValue only, see below) so typing/paste never fights React over
  // cursor position or triggers a reformat mid-keystroke.
  const [rows, setRows] = useState<Partial<Record<RowKey, BrandMap>>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  // Raw Date (not the shared page-wide formatLastUpdate() string other
  // cards on this page use) — this card's own "Last Update" indicator was
  // moved into the title row's top-right corner and restyled to match the
  // Balance tab's exact treatment (time-only, with seconds, no date) per
  // explicit instruction; every other card on this page keeps its original
  // formatLastUpdate() display, untouched.
  const [lastUpdateAt, setLastUpdateAt] = useState<Date | null>(null);
  // Drives the "Paste txn from X to today" note below — see
  // computeCatchUpNote(). Null until the fetch completes; the note stays
  // blank rather than guessing in that brief window.
  const [catchUpNote, setCatchUpNote] = useState<string | null>(null);
  // Snapshot taken the instant Edit is clicked — Cancel restores exactly
  // this, same pattern as YesterdayClosingCard/PgClosingBalancesCard above.
  const editSnapshotRef = useRef<Partial<Record<RowKey, BrandMap>> | null>(null);
  // The KPI tiles below (Total/Deposit/Withdrawal/Opening/Adjustment) read
  // from this instead of the live `rows` state, per explicit follow-up —
  // they should only refresh once Save is pressed, not on every keystroke
  // while the table itself already shows the live typed values.
  const [committedRows, setCommittedRows] = useState<Partial<Record<RowKey, BrandMap>>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/daily-txn-entry/ledger?ledgerId=${def.id}`);
      const data = await res.json();
      if (cancelled) return;
      const next: Partial<Record<RowKey, BrandMap>> = {};
      for (const r of data.rows as { brand: Brand; rowKey: RowKey; amount: number }[]) {
        next[r.rowKey] = { ...next[r.rowKey], [r.brand]: r.amount };
      }
      setRows(next);
      setCommittedRows(JSON.parse(JSON.stringify(next)));
      setLastUpdateAt(data.lastUpdate ? new Date(data.lastUpdate) : null);
      setCatchUpNote(computeCatchUpNote(data.pgBalanceAsOfDate ?? null, data.businessDate));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [def.id]);

  const rowOrder: RowKey[] = isEss
    ? ['opening', 'dpBkash', 'dpNagad', 'wdBkash', 'wdNagad', 'adjustment']
    : ['opening', 'deposit', 'withdrawal', 'adjustment'];

  const openingSum = sumRow(committedRows, 'opening');
  const depositSum = isEss
    ? sumRow(committedRows, 'dpBkash') + sumRow(committedRows, 'dpNagad')
    : sumRow(committedRows, 'deposit');
  const withdrawalSum = isEss
    ? sumRow(committedRows, 'wdBkash') + sumRow(committedRows, 'wdNagad')
    : sumRow(committedRows, 'withdrawal');
  const adjSum = sumRow(committedRows, 'adjustment');
  const totalSum = sumTotals(committedRows, def.kind);
  // SSP Line 1/2 keep "Total"; the other four gateways (ATP/EXPAY/HKPAY/ESS)
  // display "Available Balance" instead — a per-ledger override, not tied
  // to `kind` (ESS previously read "Available for WD" here; ATP/EXPAY/
  // HKPAY are 'standard' kind, same as SSP Line 1/2, so this can't be
  // derived from isEss alone anymore).
  const totalLabel = ['atp', 'expay', 'hkpay', 'ess'].includes(def.id) ? 'Available Balance' : 'Total';

  function onCellInput(e: React.FormEvent<HTMLInputElement>) {
    const { row, brand } = e.currentTarget.dataset as { row: RowKey; brand: Brand };
    const num = applyLiveCommaFormat(e.currentTarget);
    setRows((prev) => ({ ...prev, [row]: { ...prev[row], [brand]: num } }));
  }

  function onCellKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const row = e.currentTarget.dataset.row;
    const inputs = Array.from(
      containerRef.current?.querySelectorAll<HTMLInputElement>(`input[data-row="${row}"]`) ?? []
    );
    const idx = inputs.indexOf(e.currentTarget);
    if (idx > -1 && idx < inputs.length - 1) inputs[idx + 1].focus();
  }

  // Ported verbatim from the reference file's onCellPaste — tab-delimited
  // columns, multi-row block distributes across the next N editable rows in
  // sequence starting from the paste target, parentheses parse as negative,
  // thousands-comma is never treated as a delimiter. A true single-cell
  // paste (one line, no tab) is left to the browser's own default paste.
  function onCellPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const clip = e.clipboardData.getData('text');
    if (!clip) return;
    const lines = clip.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
    if (lines.length === 0) return;
    if (lines.length === 1 && !lines[0].includes('\t')) return;
    e.preventDefault();

    const { row, brand } = e.currentTarget.dataset as { row: RowKey; brand: Brand };
    const startBrandIdx = BRANDS.indexOf(brand);
    const order = EDITABLE_ROWS[def.kind];
    const startRowIdx = order.indexOf(row);

    const updates: { row: RowKey; brand: Brand; num: number }[] = [];
    lines.forEach((line, li) => {
      const targetRow = order[startRowIdx + li];
      if (!targetRow) return; // pasted more rows than editable rows remain — ignore the overflow
      const values = line.includes('\t') ? line.split('\t') : line.split(/\s{2,}|\s(?=\d)/);
      values
        .map((v) => v.trim())
        .filter((v) => v !== '')
        .forEach((raw, ci) => {
          const targetBrand = BRANDS[startBrandIdx + ci];
          if (!targetBrand) return; // pasted more columns than remaining brands — ignore the overflow
          const num = parseNum(raw);
          if (exceedsMax(num)) return; // over the cap — leave this one cell untouched, don't rewrite it
          updates.push({ row: targetRow, brand: targetBrand, num });
        });
    });
    if (updates.length === 0) return;

    setRows((prev) => {
      const next = { ...prev };
      for (const u of updates) next[u.row] = { ...next[u.row], [u.brand]: u.num };
      return next;
    });

    // Reflect the pasted values into their (uncontrolled) inputs immediately
    // — same as the reference file's own setCell(), since these inputs
    // aren't driven by `value=` and won't otherwise pick up the new state.
    for (const u of updates) {
      const input = containerRef.current?.querySelector<HTMLInputElement>(
        `input[data-row="${u.row}"][data-brand="${u.brand}"]`
      );
      if (input) {
        const formatted = u.num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        input.value = formatted;
        input.dataset.lastValid = formatted;
        input.dataset.lastValidNum = String(u.num);
      }
    }

    onActivity();
  }

  function handleEdit() {
    editSnapshotRef.current = JSON.parse(JSON.stringify(rows));
    setEditing(true);
  }

  function handleCancel() {
    if (editSnapshotRef.current) setRows(editSnapshotRef.current);
    setEditing(false);
  }

  async function handleSave() {
    setSaving(true);
    // Only the editable rows are sent — 'opening' is server-managed (carried
    // forward by the nightly rollover job) and must never be overwritten by
    // a client Save.
    const payload = EDITABLE_ROWS[def.kind].flatMap((rowKey) => BRANDS.map((brand) => ({ brand, rowKey, amount: getVal(rows, rowKey, brand) })));
    const res = await fetch('/api/daily-txn-entry/ledger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ledgerId: def.id, rows: payload }),
    });
    setSaving(false);
    if (!res.ok) return; // leave editing open so the user doesn't lose their input
    setSaved(true);
    onActivity();
    setLastUpdateAt(new Date());
    setCommittedRows(JSON.parse(JSON.stringify(rows)));
    setTimeout(() => {
      setSaved(false);
      setEditing(false);
    }, 1400);
  }

  if (loading) {
    return (
      <div
        id={`section-${def.id}`}
        className="scroll-mt-6 rounded-lg border border-[#DEE1E8] bg-white px-[22px] py-5 dark:border-[#262B38] dark:bg-[#12151D]"
      >
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3.5">
          <div className="flex flex-col gap-2">
            <SkeletonBar className="h-4 w-36" />
            <SkeletonBar className="h-3 w-52" />
          </div>
          <SkeletonBar className="h-[34px] w-[78px] rounded-[9px]" />
        </div>
        <div className="mb-3.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <SkeletonBar className="h-[74px] rounded-lg" />
          <div className="flex flex-col gap-2">
            <SkeletonBar className="h-[35px] rounded-lg" />
            <SkeletonBar className="h-[35px] rounded-lg" />
          </div>
          <div className="flex flex-col gap-2">
            <SkeletonBar className="h-[35px] rounded-lg" />
            <SkeletonBar className="h-[35px] rounded-lg" />
          </div>
        </div>
        <div className="flex flex-col gap-[3px] overflow-hidden rounded-[10px] border border-[#EFF1F4] bg-white p-[3px] dark:border-[#1A1E29] dark:bg-[#12151D]">
          <SkeletonBar className="h-[37px] w-full shrink-0 rounded-[4px]" />
          {/* One skeleton row per real body row (rowOrder) plus the Total row
              below it — kept in sync with rowOrder.length so a tall `ess`
              ledger (6 rows) and a standard one (4 rows) each get a skeleton
              the same height as their own real table, not a fixed guess. */}
          {Array.from({ length: rowOrder.length + 1 }).map((_, i) => (
            <SkeletonBar key={i} className="h-[35px] w-full shrink-0 rounded-[4px]" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      id={`section-${def.id}`}
      className="scroll-mt-6 rounded-lg border border-[#DEE1E8] bg-white px-[22px] py-5 dark:border-[#262B38] dark:bg-[#12151D]"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3.5">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
            <h2 className="text-[15px] font-bold text-foreground">
              {def.title.split(' · ')[0]}
              {def.title.includes(' · ') && (
                <span className="font-normal text-muted-foreground"> · {def.title.split(' · ')[1]}</span>
              )}
            </h2>
          </div>
          {catchUpNote && (
            <div className="mt-[5px] flex items-center gap-2.5">
              <span className="inline-flex items-center gap-[5px] rounded-full border border-[#F2C572] bg-[#FFF4E5] px-2.5 py-[3px] text-[11px] font-bold text-[#8A6D1D] dark:border-[#5A4419] dark:bg-[#3A2F14] dark:text-[#E6B854]">
                <TriangleAlert size={11} strokeWidth={2.25} />
                {catchUpNote}
              </span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* Same "Last Update" treatment as the Balance tab's own header
              indicator (time only, with seconds, no date) — moved here (top
              row, right side) and restyled per explicit instruction; hidden
              entirely rather than showing a "No data yet" placeholder when
              this ledger has nothing yet, same as Balance's own convention. */}
          {lastUpdateAt && (
            <span className="hidden text-[10.5px] text-muted-foreground sm:inline">
              Last Update: <span className="font-[500]! tabular-nums">{lastUpdateAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}</span>
            </span>
          )}
          {editing ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                onClick={handleCancel}
                className="whitespace-nowrap rounded-[9px] border border-[#DEE1E8] bg-white px-4 py-[9px] text-[12.5px] font-bold text-muted-foreground hover:border-[#E23D3D] hover:text-[color:var(--dd-neg)] dark:border-[#262B38] dark:bg-[#1A1E29]"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className={`whitespace-nowrap rounded-[9px] border-none px-4 py-[9px] text-[12.5px] font-bold text-white transition-colors disabled:opacity-60 ${
                  saved ? 'bg-[#1C9A5B]' : 'bg-[#1B2129] hover:brightness-110 dark:bg-[#F3F4F7] dark:text-[#0A0C11]'
                }`}
              >
                {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          ) : (
            <button
              onClick={handleEdit}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[#DEE1E8] bg-white px-4 py-[9px] text-[12.5px] font-bold text-muted-foreground hover:border-[#5B57E0] hover:text-[#5B57E0] dark:border-[#262B38] dark:bg-[#1A1E29]"
            >
              <Pencil size={12} strokeWidth={2.25} />
              Edit
            </button>
          )}
        </div>
      </div>

      <div className="mb-3.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <PgBalanceCard label={totalLabel} value={totalSum} openingValue={openingSum} />
        <div className="flex flex-col gap-2">
          <StatCard label="Deposit" value={depositSum} />
          <StatCard label="Opening" value={openingSum} />
        </div>
        <div className="flex flex-col gap-2">
          <StatCard label="Withdrawal" value={withdrawalSum} variant="withdrawal" />
          <StatCard label="Adjustment" value={adjSum} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-[10px] border border-[#EFF1F4] dark:border-[#1A1E29]">
        <table className="w-full min-w-[920px] border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-[4] whitespace-nowrap border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-left text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Brand
              </th>
              {BRANDS.map((b) => (
                <th
                  key={b}
                  className="sticky top-0 z-[3] whitespace-nowrap border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2.5 text-right text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]"
                >
                  {b}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowOrder.map((row) => {
              const editable = row !== 'opening';
              return (
                <tr key={row}>
                  <td
                    className={`sticky left-0 z-[2] whitespace-nowrap border-b border-[#EFF1F4] bg-white px-3.5 py-2.5 text-[12px] font-bold dark:border-[#1A1E29] dark:bg-[#12151D] ${
                      row === 'opening' ? 'text-muted-foreground' : 'text-foreground'
                    }`}
                  >
                    {ROW_LABELS[row]}
                  </td>
                  {BRANDS.map((b) => {
                    if (!editable || !editing) {
                      const v = getVal(rows, row, b);
                      return (
                        <td key={b} className="border-b border-[#EFF1F4] p-[5px] dark:border-[#1A1E29]">
                          <span
                            style={{ lineHeight: '18px' }}
                            className={`block w-full rounded-md border border-transparent px-2 py-1.5 text-right text-[12.5px] tabular-nums ${
                              v < 0 ? 'text-[color:var(--dd-neg)]' : editable ? 'text-foreground' : 'text-muted-foreground'
                            }`}
                          >
                            {fmt(v)}
                          </span>
                        </td>
                      );
                    }
                    // Derived from live state (not the original `def.rows`
                    // seed) so re-entering Edit after a previous Save shows
                    // the last-saved value, not a reset back to the initial seed.
                    const current = rows[row]?.[b];
                    const initialValue =
                      current !== undefined
                        ? current.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : '';
                    return (
                      <td key={b} className="border-b border-[#EFF1F4] p-[5px] dark:border-[#1A1E29]">
                        <input
                          type="text"
                          inputMode="decimal"
                          data-row={row}
                          data-brand={b}
                          data-last-valid={initialValue}
                          data-last-valid-num={current ?? 0}
                          defaultValue={initialValue}
                          placeholder="0.00"
                          onFocus={(e) => e.currentTarget.select()}
                          onInput={onCellInput}
                          onKeyDown={onCellKey}
                          onPaste={onCellPaste}
                          style={{ lineHeight: '18px' }}
                          className="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 text-right text-[12.5px] tabular-nums text-foreground hover:bg-[#F1F2F5] focus:border-[#5B57E0] focus:bg-white focus:shadow-[0_0_0_3px_rgba(91,87,224,0.1)] focus:outline-none dark:hover:bg-[#1A1E29] dark:focus:bg-[#12151D]"
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="bg-[#FBFBFD] dark:bg-[#0E1119]">
              <td className="sticky left-0 z-[2] whitespace-nowrap border-t border-[#DEE1E8] bg-[#FBFBFD] px-3.5 py-2.5 text-[12px] font-extrabold text-foreground dark:border-[#262B38] dark:bg-[#0E1119]">
                {totalLabel}
              </td>
              {BRANDS.map((b) => {
                const t = computeTotal(rows, def.kind, b);
                return (
                  <td
                    key={b}
                    className={`whitespace-nowrap border-t border-[#DEE1E8] px-3.5 py-2.5 text-right text-[13px] font-extrabold tabular-nums dark:border-[#262B38] ${
                      t < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'
                    }`}
                  >
                    {fmt(t)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Same "hero" card as Operations Overview's own Running Balance tile
// (app/page.tsx) — big value + a tinted ▲/▼ pill showing the net movement
// vs Opening, per explicit instruction to match that card's up/down style.
// Ported the pill markup/colors verbatim (--dd-pos/--dd-neg-dim tokens);
// this page doesn't have a sparkline data source so that part is omitted.
// Sized to sit one clear step above the table's own 13px scale (see the
// table's font-size comment above) rather than dominating it — the card
// grid and the grid below now read as one proportional system instead of
// two mismatched type scales, per explicit follow-up.
function PgBalanceCard({ label, value, openingValue }: { label: string; value: number; openingValue: number }) {
  const change = value - openingValue;
  const up = change >= 0;
  return (
    <div className="flex flex-col rounded-lg border border-[#DEE1E8] bg-white px-4 py-3 dark:border-[#262B38] dark:bg-[#12151D]">
      <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
      <div className="flex flex-1 flex-col justify-center gap-1.5">
        <p className={`text-[19px] font-semibold tabular-nums ${value < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'}`}>
          {fmt(value)}
        </p>
        <span
          className={`inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-[3px] text-[10.5px] tabular-nums ${
            up ? 'text-[color:var(--dd-pos)]' : 'text-[color:var(--dd-neg)]'
          }`}
          style={{ background: up ? 'var(--dd-pos-dim)' : 'var(--dd-neg-dim)' }}
        >
          {up ? '▲' : '▼'} {fmt(Math.abs(change))} vs opening
        </span>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  // Fixed semantic colors per explicit design spec — Deposit always reads
  // green, Withdrawal always reads accent blue, regardless of sign (unlike
  // Opening/Adjustment below, which stay neutral/red-for-negative).
  variant?: 'withdrawal';
}) {
  const colorClass =
    variant === 'withdrawal' || value < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground';
  return (
    <div className="flex flex-1 flex-col justify-between gap-1 rounded-lg border border-[#DEE1E8] bg-white px-4 py-3 dark:border-[#262B38] dark:bg-[#12151D]">
      <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
      <p className={`text-[15.5px] font-semibold tabular-nums ${colorClass}`}>{fmt(value)}</p>
    </div>
  );
}

// Single-column editable list (wallet → yesterday's closing balance) — its
// own small local state, same uncontrolled-input + live-recompute pattern as
// LedgerCard above, just without the brand-grid/paste-distribution part
// (there's only one value column here, not ten).
function YesterdayClosingCard({
  ledgerId,
  title,
  onActivity,
}: {
  ledgerId: 'ssp1' | 'ssp2';
  title: string;
  onActivity: () => void;
}) {
  const [values, setValues] = useState<Partial<Record<PgWallet, number>>>({});
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState('No data yet');
  const containerRef = useRef<HTMLDivElement>(null);
  // Captured the instant Edit is clicked — Cancel restores exactly this,
  // discarding whatever was typed since, without reverting all the way back
  // to whatever was last fetched if a prior Edit+Save cycle already changed
  // things.
  const editSnapshotRef = useRef<Partial<Record<PgWallet, number>>>({});
  const total = PG_WALLETS.reduce((s, w) => s + (values[w] ?? 0), 0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/daily-txn-entry/wallet-closing?ledgerId=${ledgerId}`);
      const json = await res.json();
      if (cancelled) return;
      const next: Partial<Record<PgWallet, number>> = {};
      for (const r of json.rows as { wallet: PgWallet; amount: number | null }[]) {
        if (r.amount !== null) next[r.wallet] = r.amount;
      }
      setValues(next);
      setLastUpdate(json.lastUpdate ? formatLastUpdate(new Date(json.lastUpdate)) : 'No data yet');
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [ledgerId]);

  function onInput(e: React.FormEvent<HTMLInputElement>) {
    const wallet = e.currentTarget.dataset.wallet as PgWallet;
    const num = applyLiveCommaFormat(e.currentTarget);
    setValues((prev) => ({ ...prev, [wallet]: num }));
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = Array.from(containerRef.current?.querySelectorAll<HTMLInputElement>('input[data-wallet]') ?? []);
    const idx = inputs.indexOf(e.currentTarget);
    if (idx > -1 && idx < inputs.length - 1) inputs[idx + 1].focus();
  }

  // Multi-row paste: a copied column of values (one per line, e.g. from a
  // spreadsheet) fills down the next N wallet rows in sequence starting
  // from the pasted cell — same convention as the Daily Entry ledger
  // tables' paste, just single-column here (one value per line, no tabs
  // expected, though a tab-containing line still degrades gracefully by
  // taking its first segment). A true single-cell paste (one line, no tab)
  // is left to the browser's own default paste.
  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const clip = e.clipboardData.getData('text');
    if (!clip) return;
    const lines = clip.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
    if (lines.length === 0) return;
    if (lines.length === 1 && !lines[0].includes('\t')) return;
    e.preventDefault();

    const startWallet = e.currentTarget.dataset.wallet as PgWallet;
    const startIdx = PG_WALLETS.indexOf(startWallet);

    const updates: { wallet: PgWallet; num: number }[] = [];
    lines.forEach((line, li) => {
      const targetWallet = PG_WALLETS[startIdx + li];
      if (!targetWallet) return; // pasted more rows than wallet rows remain — ignore the overflow
      const raw = line.includes('\t') ? line.split('\t')[0] : line;
      const num = parseNum(raw.trim());
      if (exceedsMax(num)) return; // over the cap — leave this one cell untouched, don't rewrite it
      updates.push({ wallet: targetWallet, num });
    });
    if (updates.length === 0) return;

    setValues((prev) => {
      const next = { ...prev };
      for (const u of updates) next[u.wallet] = u.num;
      return next;
    });

    for (const u of updates) {
      const input = containerRef.current?.querySelector<HTMLInputElement>(`input[data-wallet="${u.wallet}"]`);
      if (input) {
        const formatted = u.num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        input.value = formatted;
        input.dataset.lastValid = formatted;
        input.dataset.lastValidNum = String(u.num);
      }
    }

    onActivity();
  }

  function handleEdit() {
    editSnapshotRef.current = { ...values };
    setEditing(true);
  }

  function handleCancel() {
    setValues(editSnapshotRef.current);
    setEditing(false);
  }

  async function handleSave() {
    setSaving(true);
    const payload = PG_WALLETS.map((wallet) => ({ wallet, amount: values[wallet] ?? null }));
    const res = await fetch('/api/daily-txn-entry/wallet-closing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ledgerId, rows: payload }),
    });
    setSaving(false);
    if (!res.ok) return;
    setSaved(true);
    onActivity();
    setLastUpdate(formatLastUpdate(new Date()));
    setTimeout(() => {
      setSaved(false);
      setEditing(false);
    }, 1400);
  }

  if (loading) {
    return (
      <div className="w-full rounded-lg border border-[#DEE1E8] bg-white px-4 py-3.5 dark:border-[#262B38] dark:bg-[#12151D] sm:w-[340px]">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1.5">
            <SkeletonBar className="h-3.5 w-28" />
            <SkeletonBar className="h-3 w-24" />
          </div>
          <SkeletonBar className="h-[26px] w-[62px] rounded-[8px]" />
        </div>
        <div className="flex flex-col gap-2 border-t border-[#EFF1F4] pt-2.5 dark:border-[#1A1E29]">
          {PG_WALLETS.map((w) => (
            <div key={w} className="flex items-center justify-between gap-2 py-1">
              <SkeletonBar className="h-3 w-14" />
              <SkeletonBar className="h-3 w-[100px]" />
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex items-center justify-between border-t border-[#DEE1E8] pt-2 dark:border-[#262B38]">
          <SkeletonBar className="h-3.5 w-14" />
          <SkeletonBar className="h-3.5 w-20" />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full rounded-lg border border-[#DEE1E8] bg-white px-4 py-3.5 dark:border-[#262B38] dark:bg-[#12151D] sm:w-[340px]"
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
            <h2 className="text-[13.5px] font-bold text-foreground">{title}</h2>
          </div>
          <span className="mt-[3px] block text-[11px] text-muted-foreground">Last update: {lastUpdate}</span>
        </div>
        {editing ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={handleCancel}
              className="whitespace-nowrap rounded-[8px] border border-[#DEE1E8] bg-white px-3 py-[6px] text-[11px] font-bold text-muted-foreground hover:border-[#E23D3D] hover:text-[color:var(--dd-neg)] dark:border-[#262B38] dark:bg-[#1A1E29]"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className={`whitespace-nowrap rounded-[8px] border-none px-3 py-[6px] text-[11px] font-bold text-white transition-colors disabled:opacity-60 ${
                saved ? 'bg-[#1C9A5B]' : 'bg-[#1B2129] hover:brightness-110 dark:bg-[#F3F4F7] dark:text-[#0A0C11]'
              }`}
            >
              {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : (
          <button
            onClick={handleEdit}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[8px] border border-[#DEE1E8] bg-white px-3 py-[6px] text-[11px] font-bold text-muted-foreground hover:border-[#5B57E0] hover:text-[#5B57E0] dark:border-[#262B38] dark:bg-[#1A1E29]"
          >
            <Pencil size={10.5} strokeWidth={2.25} />
            Edit
          </button>
        )}
      </div>
      <div className="flex items-center justify-between border-b border-[#EFF1F4] pb-1.5 text-[10px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29]">
        <span>Wallet</span>
        <span>Yesterday Closing</span>
      </div>
      <div className="flex flex-col divide-y divide-[#EFF1F4] dark:divide-[#1A1E29]">
        {PG_WALLETS.map((w) => {
          // Derived from live state (not the original `seed` prop) so
          // re-entering Edit after a previous Save shows the last-saved
          // value, not a reset back to the initial seed.
          const val = values[w];
          const initialValue =
            val !== undefined ? val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
          if (!editing) {
            const current = values[w] ?? 0;
            return (
              <div key={w} className="flex items-center justify-between gap-2 py-1.5">
                <span className="text-[11.5px] font-bold text-foreground">{w}</span>
                <span
                  style={{ lineHeight: '18px' }}
                  className={`w-[140px] rounded-md border border-transparent px-2 py-1 text-right text-[12px] tabular-nums ${
                    current < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'
                  }`}
                >
                  {fmt(current)}
                </span>
              </div>
            );
          }
          return (
            <div key={w} className="flex items-center justify-between gap-2 py-1.5">
              <span className="text-[11.5px] font-bold text-foreground">{w}</span>
              <input
                type="text"
                inputMode="decimal"
                data-wallet={w}
                data-last-valid={initialValue}
                data-last-valid-num={val ?? 0}
                defaultValue={initialValue}
                placeholder="0.00"
                onFocus={(e) => e.currentTarget.select()}
                onInput={onInput}
                onKeyDown={onKey}
                onPaste={onPaste}
                className="w-[140px] rounded-md border border-transparent bg-transparent px-2 py-1 text-right text-[12px] tabular-nums text-foreground hover:bg-[#F1F2F5] focus:border-[#5B57E0] focus:bg-white focus:shadow-[0_0_0_3px_rgba(91,87,224,0.1)] focus:outline-none dark:hover:bg-[#1A1E29] dark:focus:bg-[#12151D]"
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between border-t border-[#DEE1E8] pt-2 dark:border-[#262B38]">
        <span className="text-[11.5px] font-extrabold text-foreground">Total</span>
        <span className={`text-[13px] font-extrabold tabular-nums ${total < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'}`}>
          {fmt(total)}
        </span>
      </div>
    </div>
  );
}

type EstimatedWalletRow = { wallet: (typeof PG_WALLETS)[number]; amount: number | null; totalDp: number | null; totalWd: number | null; opening: number | null };
// "Per Shop" row — one per Opening shop, never split. displayName is
// Opening's own raw per-wallet name when the shop has exactly one
// opening_wallet_lines row (Opening is the source of truth for shop
// names), otherwise the bare agentCode. openingBalance/deposit/withdrawal
// are shown as their own columns per explicit spec
// (Estimated Balance = Opening Balance + Total Deposit − Total
// Withdrawal); deposit/withdrawal already fold in today's Top Up/
// Settlement alongside the uploaded file's own Deposit/Withdrawal.
type EstimatedAgentRow = { agentCode: string; displayName: string; openingBalance: number; deposit: number; withdrawal: number; estimatedBalance: number };

type EstimatedLedgerState = {
  walletRows: EstimatedWalletRow[];
  agentRows: EstimatedAgentRow[];
  loading: boolean;
  lastUpdate: string;
  fileInfo: string | null;
};

// Read-only — no upload here. Per explicit instruction, the single upload
// point stays the Balance page's own "Estimate Balance" modal; this tab
// just displays that same upload's result (see app/api/daily-txn-entry/
// estimated/route.ts's own comment). A custom hook (not a component) so
// EstimatedTabContent below can call it once per ledger (ssp1/ssp2 are
// fixed call sites, not a loop — no rules-of-hooks issue) and place the two
// ledgers' wallet cards and agent tables in separate side-by-side rows, per
// explicit layout request, rather than each ledger owning a single
// vertical block.
function useEstimatedLedgerData(ledgerId: 'ssp1' | 'ssp2'): EstimatedLedgerState {
  const [walletRows, setWalletRows] = useState<EstimatedWalletRow[]>([]);
  const [agentRows, setAgentRows] = useState<EstimatedAgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState('No upload yet');
  const [fileInfo, setFileInfo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/daily-txn-entry/estimated?ledgerId=${ledgerId}`);
      const json = await res.json();
      if (cancelled) return;
      setWalletRows(json.walletRows ?? []);
      setAgentRows(json.shopRows ?? []);
      setLastUpdate(json.uploadedAt ? formatLastUpdate(new Date(json.uploadedAt)) : 'No upload yet');
      setFileInfo(json.fileName ? `${json.fileName}${json.rowCount !== null && json.rowCount !== undefined ? ` · ${json.rowCount} shops` : ''}` : null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [ledgerId]);

  return { walletRows, agentRows, loading, lastUpdate, fileInfo };
}

// Two side-by-side sections (Wallet Breakdown, then Estimated Opening),
// SSP Line1 on the left / SSP Line2 on the right in both — per explicit
// layout request, matching the existing "Wallet Breakdown Opening" section's
// own left/right card convention exactly, rather than stacking each
// ledger's wallet card + agent table as one vertical unit.
function EstimatedTabContent() {
  const ssp1 = useEstimatedLedgerData('ssp1');
  const ssp2 = useEstimatedLedgerData('ssp2');

  return (
    <div className="flex flex-col gap-6">
      <div className="scroll-mt-6">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          Wallet Breakdown Estimated
        </h2>
        <div className="flex flex-wrap gap-4">
          <EstimatedWalletCard title="SSP Line1 · Cashout" state={ssp1} />
          <EstimatedWalletCard title="SSP Line2 · Send Money" state={ssp2} />
        </div>
      </div>
      <div className="scroll-mt-6">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          Estimated Opening (Each Shop)
        </h2>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
          <EstimatedOpeningTable title="SSP Line1 Agents" rows={ssp1.agentRows} loading={ssp1.loading} exportLabel="SSP_Line1" />
          <EstimatedOpeningTable title="SSP Line2 Agents" rows={ssp2.agentRows} loading={ssp2.loading} exportLabel="SSP_Line2" />
        </div>
      </div>
    </div>
  );
}

// Same column richness as the Per Shop table below it, per explicit
// follow-up instruction ("i-same mo sa baba") — Wallet / Opening / Total
// DP / Total WD / Estimated, not just Wallet / Estimated. All 4 figures
// were already computed server-side (app/api/daily-txn-entry/estimated/
// route.ts's own walletTypeCards) — opening + totalDp/totalWd just weren't
// being rendered.
function EstimatedWalletCard({ title, state }: { title: string; state: EstimatedLedgerState }) {
  const { walletRows: rows, loading, lastUpdate, fileInfo } = state;
  const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const totalOpening = rows.reduce((s, r) => s + (r.opening ?? 0), 0);
  const totalDp = rows.reduce((s, r) => s + (r.totalDp ?? 0), 0);
  const totalWd = rows.reduce((s, r) => s + (r.totalWd ?? 0), 0);

  function handleDownload() {
    const data: { Wallet: string; 'Opening Balance': number; 'Total DP': number; 'Total WD': number; Estimated: number }[] = rows.map((r) => ({ Wallet: r.wallet, 'Opening Balance': r.opening ?? 0, 'Total DP': r.totalDp ?? 0, 'Total WD': r.totalWd ?? 0, Estimated: r.amount ?? 0 }));
    data.push({ Wallet: 'Total', 'Opening Balance': totalOpening, 'Total DP': totalDp, 'Total WD': totalWd, Estimated: total });
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Wallet Breakdown Estimated');
    XLSX.writeFile(workbook, `Wallet_Breakdown_Estimated_${title.replace(/[^A-Za-z0-9]+/g, '_')}.xlsx`);
  }

  return (
    <div className="w-full rounded-lg border border-[#DEE1E8] bg-white px-4 py-3.5 dark:border-[#262B38] dark:bg-[#12151D] sm:w-[560px]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
            <h2 className="text-[13.5px] font-bold text-foreground">{title}</h2>
          </div>
          <span className="mt-[3px] block text-[11px] text-muted-foreground">Last upload: {loading ? '…' : lastUpdate}</span>
        </div>
        <button
          onClick={handleDownload}
          disabled={loading || rows.every((r) => r.amount === null)}
          title="Download"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[8px] border border-[#DEE1E8] bg-white px-2.5 py-[6px] text-[11px] font-bold text-muted-foreground transition-colors hover:border-[#5B57E0] hover:text-[#5B57E0] disabled:opacity-40 dark:border-[#262B38] dark:bg-[#1A1E29]"
        >
          <Download size={10.5} strokeWidth={2.25} />
        </button>
      </div>
      {loading ? (
        <>
          <div className="flex flex-col gap-2 border-t border-[#EFF1F4] pt-2.5 dark:border-[#1A1E29]">
            {PG_WALLETS.map((w) => (
              <div key={w} className="flex items-center justify-between gap-2 py-1">
                <SkeletonBar className="h-3 w-14" />
                <SkeletonBar className="h-3 w-[100px]" />
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex items-center justify-between border-t border-[#DEE1E8] pt-2 dark:border-[#262B38]">
            <SkeletonBar className="h-3.5 w-14" />
            <SkeletonBar className="h-3.5 w-20" />
          </div>
        </>
      ) : (
        <>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[#EFF1F4] text-[10px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29]">
                <th className="px-2 py-1.5 text-left">Wallet</th>
                <th className="px-2 py-1.5 text-right">Opening</th>
                <th className="px-2 py-1.5 text-right">Total DP</th>
                <th className="px-2 py-1.5 text-right">Total WD</th>
                <th className="px-2 py-1.5 text-right">Estimated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EFF1F4] dark:divide-[#1A1E29]">
              {rows.map((r) => (
                <tr key={r.wallet}>
                  <td className="whitespace-nowrap px-2 py-1.5 text-[11.5px] font-bold text-foreground">{r.wallet}</td>
                  <td className={`whitespace-nowrap px-2 py-1.5 text-right text-[12px] tabular-nums ${r.opening === null ? 'text-muted-foreground' : (r.opening ?? 0) < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'}`}>
                    {r.opening === null ? '—' : fmt(r.opening)}
                  </td>
                  <td className={`whitespace-nowrap px-2 py-1.5 text-right text-[12px] tabular-nums ${r.totalDp === null ? 'text-muted-foreground' : (r.totalDp ?? 0) < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'}`}>
                    {r.totalDp === null ? '—' : fmt(r.totalDp)}
                  </td>
                  <td className={`whitespace-nowrap px-2 py-1.5 text-right text-[12px] tabular-nums ${r.totalWd === null ? 'text-muted-foreground' : (r.totalWd ?? 0) < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'}`}>
                    {r.totalWd === null ? '—' : fmt(r.totalWd)}
                  </td>
                  <td className={`whitespace-nowrap px-2 py-1.5 text-right text-[12px] tabular-nums ${r.amount === null ? 'text-muted-foreground' : (r.amount ?? 0) < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'}`}>
                    {r.amount === null ? '—' : fmt(r.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-1.5 flex items-center justify-between border-t border-[#DEE1E8] pt-2 dark:border-[#262B38]">
            <span className="text-[11.5px] font-extrabold text-foreground">Total</span>
            <span className={`text-[13px] font-extrabold tabular-nums ${total < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'}`}>
              {fmt(total)}
            </span>
          </div>
          {fileInfo && (
            <p className="mt-2 truncate text-[10px] text-muted-foreground" title={fileInfo}>
              {fileInfo}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// Compact numeric cell — shared shape between this table and
// EstimatedWalletCard above.
function EstimatedNumCell({ value }: { value: number }) {
  return (
    <td className={`whitespace-nowrap px-2 py-1.5 text-right text-[11.5px] tabular-nums ${value < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'}`}>
      {fmt(value)}
    </td>
  );
}

// Per Shop — Shop / Opening Balance / Total Deposit / Total Withdrawal /
// Estimated Balance, per explicit spec. A real <table> (not the old 2-column
// flex list) since there are now 4 data columns to show.
function EstimatedOpeningTable({ title, rows, loading, exportLabel }: { title: string; rows: EstimatedAgentRow[]; loading: boolean; exportLabel: string }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return rows;
    return rows.filter((r) => r.agentCode.toUpperCase().includes(q) || r.displayName.toUpperCase().includes(q));
  }, [rows, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  function handleDownload() {
    const data = filtered.map((r) => ({ 'Shop Name': r.displayName, 'Opening Balance': r.openingBalance, 'Total Deposit': r.deposit, 'Total Withdrawal': r.withdrawal, 'Estimated Balance': r.estimatedBalance }));
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Estimated Opening');
    XLSX.writeFile(workbook, `Estimated_Opening_${exportLabel.replace(/[^A-Za-z0-9]+/g, '_')}.xlsx`);
  }

  return (
    <div className="w-full rounded-lg border border-[#DEE1E8] bg-white px-4 py-3.5 dark:border-[#262B38] dark:bg-[#12151D] xl:w-[720px]">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
          <h2 className="text-[13.5px] font-bold text-foreground">{title}</h2>
          <span className="text-[11px] text-muted-foreground">({rows.length} shops)</span>
        </div>
        <button
          onClick={handleDownload}
          disabled={filtered.length === 0}
          title="Download"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[8px] border border-[#DEE1E8] bg-white px-2.5 py-[6px] text-[11px] font-bold text-muted-foreground transition-colors hover:border-[#5B57E0] hover:text-[#5B57E0] disabled:opacity-40 dark:border-[#262B38] dark:bg-[#1A1E29]"
        >
          <Download size={10.5} strokeWidth={2.25} />
        </button>
      </div>
      <div className="mb-3 flex justify-end">
        <div className="relative">
          <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="Search shop…"
            className="w-[150px] rounded-[8px] border border-[#DEE1E8] bg-white py-[5px] pl-6 pr-2 text-[11px] text-foreground focus:border-[#5B57E0] focus:outline-none dark:border-[#262B38] dark:bg-[#1A1E29]"
          />
        </div>
      </div>
      {loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-2 py-1">
              <SkeletonBar className="h-3 w-20" />
              <SkeletonBar className="h-3 w-[100px]" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-muted-foreground">No upload yet.</p>
      ) : (
        <>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-white dark:bg-[#12151D]">
                <tr className="border-b border-[#EFF1F4] text-[10px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29]">
                  <th className="px-2 py-1.5 text-left">Shop</th>
                  <th className="px-2 py-1.5 text-right">Opening Balance</th>
                  <th className="px-2 py-1.5 text-right">Total Deposit</th>
                  <th className="px-2 py-1.5 text-right">Total Withdrawal</th>
                  <th className="px-2 py-1.5 text-right">Estimated Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFF1F4] dark:divide-[#1A1E29]">
                {pageRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-[12px] text-muted-foreground">No shop matches &quot;{query}&quot;.</td>
                  </tr>
                ) : (
                  pageRows.map((r) => (
                    <tr key={`${r.agentCode}:${r.displayName}`}>
                      <td className="whitespace-nowrap px-2 py-1.5 text-[11.5px] font-medium text-foreground">{r.displayName}</td>
                      <EstimatedNumCell value={r.openingBalance} />
                      <EstimatedNumCell value={r.deposit} />
                      <EstimatedNumCell value={r.withdrawal} />
                      <EstimatedNumCell value={r.estimatedBalance} />
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-[#DEE1E8] pt-2 dark:border-[#262B38]">
            <span className="text-[10.5px] text-muted-foreground">
              Page {page + 1} of {pageCount}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="rounded-[6px] border border-[#DEE1E8] p-1 text-muted-foreground disabled:opacity-30 dark:border-[#262B38]"
              >
                <ChevronLeft size={12} />
              </button>
              <button
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                className="rounded-[6px] border border-[#DEE1E8] p-1 text-muted-foreground disabled:opacity-30 dark:border-[#262B38]"
              >
                <ChevronRight size={12} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Editable, transposed from the Daily Entry ledger tables: rows here are
// Brand (M1..J1) and columns are PG (AUTOPAY/EXPAY/SSP Line1/SSP Line2
// (Personal)/ESS-PG/HKPAY), per explicit follow-up — same uncontrolled-
// input + live-recompute + paste-distribution pattern as LedgerCard above,
// just with the row/column dimensions swapped. GET/POST
// /api/daily-txn-entry/pg-balance — self-contained (see that table's
// schema.ts comment), NOT derived from the Operations tab's ledgers.
function PgClosingBalancesCard({ onActivity }: { onActivity: () => void }) {
  const [data, setData] = useState<Record<PgKey, BrandMap>>(
    () => Object.fromEntries(PG_KEYS.map((k) => [k, {}])) as Record<PgKey, BrandMap>
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  // Per-PG "last update" — genuinely independent per column (not one
  // shared value replicated across all six). Save still commits every cell
  // in the grid at once (one shared Edit/Save for the whole table), but
  // upsertPgBalanceEntries only bumps a row's own updated_at when its
  // amount actually changed, so the server's own lastUpdateByPg correctly
  // reflects "which PG(s) were genuinely edited" — per explicit
  // instruction, editing only AUTOPAY must never also bump EXPAY/SSP
  // LINE1/etc's own displayed timestamp.
  const [lastUpdate, setLastUpdate] = useState<Record<PgKey, string>>(
    () => Object.fromEntries(PG_KEYS.map((k) => [k, 'No data yet'])) as Record<PgKey, string>
  );
  // Snapshot taken the instant Edit is clicked — Cancel restores exactly
  // this, same pattern as YesterdayClosingCard above.
  const editSnapshotRef = useRef<Record<PgKey, BrandMap> | null>(null);

  const loadData = useCallback(async () => {
    const res = await fetch('/api/daily-txn-entry/pg-balance');
    const json = await res.json();
    const next = Object.fromEntries(PG_KEYS.map((k) => [k, {}])) as Record<PgKey, BrandMap>;
    for (const r of json.rows as { pgKey: PgKey; brand: Brand; amount: number | null }[]) {
      if (r.amount !== null) next[r.pgKey] = { ...next[r.pgKey], [r.brand]: r.amount };
    }
    const lastUpdateByPg = (json.lastUpdateByPg ?? {}) as Record<PgKey, string | null>;
    setData(next);
    setLastUpdate(
      Object.fromEntries(
        PG_KEYS.map((k) => [k, lastUpdateByPg[k] ? formatLastUpdate(new Date(lastUpdateByPg[k]!)) : 'No data yet'])
      ) as Record<PgKey, string>
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadData();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [loadData]);

  function handleEdit() {
    editSnapshotRef.current = Object.fromEntries(PG_KEYS.map((k) => [k, { ...data[k] }])) as Record<PgKey, BrandMap>;
    setEditing(true);
  }

  function handleCancel() {
    if (editSnapshotRef.current) setData(editSnapshotRef.current);
    setEditing(false);
  }

  async function handleSave() {
    setSaving(true);
    const payload = PG_KEYS.flatMap((pgKey) => BRANDS.map((brand) => ({ pgKey, brand, amount: data[pgKey]?.[brand] ?? null })));
    const res = await fetch('/api/daily-txn-entry/pg-balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: payload }),
    });
    setSaving(false);
    if (!res.ok) return;
    setSaved(true);
    onActivity();
    // Re-fetch rather than assuming every PG just changed — the server
    // only actually bumped updated_at for the PG(s) whose amount genuinely
    // differed from what was already stored (see upsertPgBalanceEntries),
    // so this is what correctly leaves an untouched PG's own "Last Update"
    // alone instead of dragging it forward to "just now" too.
    await loadData();
    setTimeout(() => {
      setSaved(false);
      setEditing(false);
    }, 1400);
  }

  function setCell(brand: Brand, pg: PgKey, num: number) {
    setData((prev) => ({ ...prev, [pg]: { ...prev[pg], [brand]: num } }));
  }

  function onCellInput(e: React.FormEvent<HTMLInputElement>) {
    const { brand, pg } = e.currentTarget.dataset as { brand: Brand; pg: PgKey };
    const num = applyLiveCommaFormat(e.currentTarget);
    setCell(brand, pg, num);
  }

  function onCellKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const brand = e.currentTarget.dataset.brand;
    const inputs = Array.from(
      containerRef.current?.querySelectorAll<HTMLInputElement>(`input[data-brand="${brand}"]`) ?? []
    );
    const idx = inputs.indexOf(e.currentTarget);
    if (idx > -1 && idx < inputs.length - 1) inputs[idx + 1].focus();
  }

  // Same paste convention as the Daily Entry ledger tables, transposed: a
  // single-row (tab-delimited) paste distributes across PG columns from the
  // pasted cell onward; a multi-row paste distributes down the next N
  // Brand rows in sequence; parentheses parse as negative; commas are
  // never a delimiter.
  function onCellPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const clip = e.clipboardData.getData('text');
    if (!clip) return;
    const lines = clip.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
    if (lines.length === 0) return;
    if (lines.length === 1 && !lines[0].includes('\t')) return;
    e.preventDefault();

    const { brand, pg } = e.currentTarget.dataset as { brand: Brand; pg: PgKey };
    const startBrandIdx = BRANDS.indexOf(brand);
    const startPgIdx = PG_KEYS.indexOf(pg);

    const updates: { brand: Brand; pg: PgKey; num: number }[] = [];
    lines.forEach((line, li) => {
      const targetBrand = BRANDS[startBrandIdx + li];
      if (!targetBrand) return; // pasted more rows than Brand rows remain — ignore the overflow
      const values = line.includes('\t') ? line.split('\t') : line.split(/\s{2,}|\s(?=\d)/);
      values
        .map((v) => v.trim())
        .filter((v) => v !== '')
        .forEach((raw, ci) => {
          const targetPg = PG_KEYS[startPgIdx + ci];
          if (!targetPg) return; // pasted more columns than PG columns remain — ignore the overflow
          const num = parseNum(raw);
          if (exceedsMax(num)) return; // over the cap — leave this one cell untouched, don't rewrite it
          updates.push({ brand: targetBrand, pg: targetPg, num });
        });
    });
    if (updates.length === 0) return;

    setData((prev) => {
      const next = { ...prev };
      for (const u of updates) next[u.pg] = { ...next[u.pg], [u.brand]: u.num };
      return next;
    });

    for (const u of updates) {
      const input = containerRef.current?.querySelector<HTMLInputElement>(
        `input[data-brand="${u.brand}"][data-pg="${u.pg}"]`
      );
      if (input) {
        const formatted = u.num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        input.value = formatted;
        input.dataset.lastValid = formatted;
        input.dataset.lastValidNum = String(u.num);
      }
    }

    onActivity();
  }

  if (loading) {
    return (
      <div id="section-pg-closing" className="scroll-mt-6 rounded-lg border border-[#DEE1E8] bg-white px-[22px] py-5 dark:border-[#262B38] dark:bg-[#12151D]">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3.5">
          <SkeletonBar className="h-4 w-44" />
          <SkeletonBar className="h-[34px] w-[78px] rounded-[9px]" />
        </div>
        <div className="flex flex-col gap-[3px] overflow-hidden rounded-[10px] border border-[#EFF1F4] bg-white p-[3px] dark:border-[#1A1E29] dark:bg-[#12151D]">
          <SkeletonBar className="h-[52px] w-full shrink-0 rounded-[4px]" />
          {/* One row per brand plus the Total row, matching the real table. */}
          {Array.from({ length: BRANDS.length + 1 }).map((_, i) => (
            <SkeletonBar key={i} className="h-[35px] w-full shrink-0 rounded-[4px]" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      id="section-pg-closing"
      className="scroll-mt-6 rounded-lg border border-[#DEE1E8] bg-white px-[22px] py-5 dark:border-[#262B38] dark:bg-[#12151D]"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
          <h2 className="text-[15px] font-bold text-foreground">PG Closing Balances</h2>
        </div>
        {editing ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={handleCancel}
              className="whitespace-nowrap rounded-[9px] border border-[#DEE1E8] bg-white px-4 py-[9px] text-[12.5px] font-bold text-muted-foreground hover:border-[#E23D3D] hover:text-[color:var(--dd-neg)] dark:border-[#262B38] dark:bg-[#1A1E29]"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className={`whitespace-nowrap rounded-[9px] border-none px-4 py-[9px] text-[12.5px] font-bold text-white transition-colors disabled:opacity-60 ${
                saved ? 'bg-[#1C9A5B]' : 'bg-[#1B2129] hover:brightness-110 dark:bg-[#F3F4F7] dark:text-[#0A0C11]'
              }`}
            >
              {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : (
          <button
            onClick={handleEdit}
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[#DEE1E8] bg-white px-4 py-[9px] text-[12.5px] font-bold text-muted-foreground hover:border-[#5B57E0] hover:text-[#5B57E0] dark:border-[#262B38] dark:bg-[#1A1E29]"
          >
            <Pencil size={12} strokeWidth={2.25} />
            Edit
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-[10px] border border-[#EFF1F4] dark:border-[#1A1E29]">
        <table className="w-full min-w-[760px] border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-[4] whitespace-nowrap bg-[#FAFBFC] px-3 py-2.5 text-left text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:bg-[#0E1119]">
                Brand
              </th>
              {PG_KEYS.map((pg) => (
                <th
                  key={pg}
                  className="sticky top-0 z-[3] whitespace-nowrap bg-[#FAFBFC] px-3 py-2.5 text-right text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:bg-[#0E1119]"
                >
                  {PG_LABELS[pg]}
                </th>
              ))}
            </tr>
            {/* Per-PG "last update" sub-row — see handleSave: one Save
                action covers the whole table, so all six refresh together,
                but each column's own date still shows under its header. */}
            <tr>
              <th className="sticky left-0 top-[33px] z-[4] whitespace-nowrap border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 pb-2 text-left text-[10px] font-normal normal-case text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Last Update
              </th>
              {PG_KEYS.map((pg) => (
                <th
                  key={pg}
                  className="sticky top-[33px] z-[3] whitespace-nowrap border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 pb-2 text-right text-[10px] font-normal normal-case text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]"
                >
                  {lastUpdate[pg]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {BRANDS.map((brand) => (
              <tr key={brand}>
                <td className="sticky left-0 z-[2] whitespace-nowrap border-b border-[#EFF1F4] bg-white px-3.5 py-2.5 text-[12px] font-bold text-foreground dark:border-[#1A1E29] dark:bg-[#12151D]">
                  {brand}
                </td>
                {PG_KEYS.map((pg) => {
                  if (!editing) {
                    const v = data[pg][brand] ?? 0;
                    return (
                      <td key={pg} className="border-b border-[#EFF1F4] p-[5px] dark:border-[#1A1E29]">
                        <span
                          style={{ lineHeight: '18px' }}
                          className={`block w-full rounded-md border border-transparent px-2 py-1.5 text-right text-[12.5px] tabular-nums ${
                            v < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'
                          }`}
                        >
                          {fmt(v)}
                        </span>
                      </td>
                    );
                  }
                  const current = data[pg][brand];
                  const initialValue =
                    current !== undefined
                      ? current.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                      : '';
                  return (
                    <td key={pg} className="border-b border-[#EFF1F4] p-[5px] dark:border-[#1A1E29]">
                      <input
                        type="text"
                        inputMode="decimal"
                        data-brand={brand}
                        data-pg={pg}
                        data-last-valid={initialValue}
                        data-last-valid-num={current ?? 0}
                        defaultValue={initialValue}
                        placeholder="0.00"
                        onFocus={(e) => e.currentTarget.select()}
                        onInput={onCellInput}
                        onKeyDown={onCellKey}
                        onPaste={onCellPaste}
                        style={{ lineHeight: '18px' }}
                        className="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 text-right text-[12.5px] tabular-nums text-foreground hover:bg-[#F1F2F5] focus:border-[#5B57E0] focus:bg-white focus:shadow-[0_0_0_3px_rgba(91,87,224,0.1)] focus:outline-none dark:hover:bg-[#1A1E29] dark:focus:bg-[#12151D]"
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="bg-[#FBFBFD] dark:bg-[#0E1119]">
              <td className="sticky left-0 z-[2] whitespace-nowrap border-t border-[#DEE1E8] bg-[#FBFBFD] px-3.5 py-2.5 text-[12px] font-extrabold text-foreground dark:border-[#262B38] dark:bg-[#0E1119]">
                Total
              </td>
              {PG_KEYS.map((pg) => {
                const t = BRANDS.reduce((s, b) => s + (data[pg][b] ?? 0), 0);
                return (
                  <td
                    key={pg}
                    className={`whitespace-nowrap border-t border-[#DEE1E8] px-3.5 py-2.5 text-right text-[13px] font-extrabold tabular-nums dark:border-[#262B38] ${
                      t < 0 ? 'text-[color:var(--dd-neg)]' : 'text-foreground'
                    }`}
                  >
                    {fmt(t)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

const PAGE_TABS: { key: 'daily' | 'pg' | 'cashgo' | 'estimated'; label: string }[] = [
  { key: 'daily', label: 'Operations' },
  { key: 'pg', label: 'Report' },
  { key: 'cashgo', label: 'CashGo' },
  { key: 'estimated', label: 'Estimated' },
];

// Whole-number formatting (no decimals) — this table's own convention,
// distinct from fmt()'s 2-decimal ledger-accounting style, matching the
// reference design exactly (e.g. "4,966,740" not "4,966,740.00").
function fmtWhole(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

type CashGoDailyRecord = {
  date: string;
  bkashTarget?: number;
  bkashProcess?: number;
  nagadTarget?: number;
  nagadProcess?: number;
  isToday?: boolean;
};

// GET/POST /api/daily-txn-entry/cashgo — "today"'s Bkash/Nagad Target/
// Process, the Operations tab's own entry point for CashGo (see that
// table's schema.ts comment: this same table also backs CashGo tab's
// history further down, via the read module's ?history=1 branch). The Add
// button from the original reference file's header was never wired here
// (its own modal markup in that file was never actually hooked up to an
// "add row" action either) — out of scope until asked for.

// Editable per-channel view, placed above the ledgers in the Operations tab
// per explicit instruction, ahead of "SSP Line 1 · Cashout". Each day
// renders as two rows (Bkash then Nagad) with Date/Total rowSpan-ed across
// the pair, matching the reference file's own long-format layout. Same
// Edit/Cancel/Save + live-typing conventions as LedgerCard above; no
// separate KPI tiles here so the table itself is the only thing that needs
// to stay live/reflect Save.
function CashGoHourlyCard({ onActivity }: { onActivity: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<CashGoDailyRecord[]>([]);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState('No data yet');
  const editSnapshotRef = useRef<CashGoDailyRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch('/api/daily-txn-entry/cashgo');
      const json = await res.json();
      if (cancelled) return;
      const channelRows = json.rows as { channel: 'bkash' | 'nagad'; target: number | null; process: number | null }[];
      const bkash = channelRows.find((r) => r.channel === 'bkash');
      const nagad = channelRows.find((r) => r.channel === 'nagad');
      const [, m, d] = (json.businessDate as string).split('-');
      setRows([
        {
          date: `Today's Quota - ${m}/${d}`,
          bkashTarget: bkash?.target ?? undefined,
          bkashProcess: bkash?.process ?? undefined,
          nagadTarget: nagad?.target ?? undefined,
          nagadProcess: nagad?.process ?? undefined,
          isToday: true,
        },
      ]);
      setLastUpdate(json.lastUpdate ? formatLastUpdate(new Date(json.lastUpdate)) : 'No data yet');
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function onTargetInput(e: React.FormEvent<HTMLInputElement>) {
    const { date, channel } = e.currentTarget.dataset as { date: string; channel: 'bkash' | 'nagad' };
    const num = applyLiveCommaFormat(e.currentTarget);
    setRows((prev) =>
      prev.map((r) => {
        if (r.date !== date) return r;
        return channel === 'bkash' ? { ...r, bkashTarget: num } : { ...r, nagadTarget: num };
      })
    );
  }

  function onProcessInput(e: React.FormEvent<HTMLInputElement>) {
    const { date, channel } = e.currentTarget.dataset as { date: string; channel: 'bkash' | 'nagad' };
    const num = applyLiveCommaFormat(e.currentTarget);
    setRows((prev) =>
      prev.map((r) => {
        if (r.date !== date) return r;
        return channel === 'bkash' ? { ...r, bkashProcess: num } : { ...r, nagadProcess: num };
      })
    );
  }

  function handleEdit() {
    editSnapshotRef.current = JSON.parse(JSON.stringify(rows));
    setEditing(true);
  }

  function handleCancel() {
    if (editSnapshotRef.current) setRows(editSnapshotRef.current);
    setEditing(false);
  }

  async function handleSave() {
    setSaving(true);
    const day = rows[0];
    const results = await Promise.all(
      (['bkash', 'nagad'] as const).map((channel) =>
        fetch('/api/daily-txn-entry/cashgo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel,
            target: channel === 'bkash' ? (day?.bkashTarget ?? null) : (day?.nagadTarget ?? null),
            process: channel === 'bkash' ? (day?.bkashProcess ?? null) : (day?.nagadProcess ?? null),
          }),
        })
      )
    );
    setSaving(false);
    if (results.some((r) => !r.ok)) return;
    setSaved(true);
    onActivity();
    setLastUpdate(formatLastUpdate(new Date()));
    setTimeout(() => {
      setSaved(false);
      setEditing(false);
    }, 1400);
  }

  if (loading) {
    return (
      <div id="section-cashgo-hourly" className="scroll-mt-6 rounded-lg border border-[#DEE1E8] bg-white px-[22px] py-5 dark:border-[#262B38] dark:bg-[#12151D]">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3.5">
          <div className="flex flex-col gap-2">
            <SkeletonBar className="h-4 w-48" />
            <SkeletonBar className="h-3 w-40" />
          </div>
          <SkeletonBar className="h-[34px] w-[78px] rounded-[9px]" />
        </div>
        <div className="flex flex-col gap-[3px] overflow-hidden rounded-[10px] border border-[#EFF1F4] bg-white p-[3px] dark:border-[#1A1E29] dark:bg-[#12151D]">
          <SkeletonBar className="h-[37px] w-full shrink-0 rounded-[4px]" />
          <SkeletonBar className="h-[38px] w-full shrink-0 rounded-[4px]" />
          <SkeletonBar className="h-[38px] w-full shrink-0 rounded-[4px]" />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      id="section-cashgo-hourly"
      className="scroll-mt-6 rounded-lg border border-[#DEE1E8] bg-white px-[22px] py-5 dark:border-[#262B38] dark:bg-[#12151D]"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3.5">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
            <h2 className="text-[15px] font-bold text-foreground">
              CashGo<span className="font-normal text-muted-foreground"> · Hourly Tracking</span>
            </h2>
          </div>
          <div className="mt-[5px] flex items-center gap-2.5">
            <span className="text-[12px] text-muted-foreground">Last update: {lastUpdate}</span>
            <span className="inline-flex items-center gap-[5px] rounded-full border border-[#F2C572] bg-[#FFF4E5] px-2.5 py-[3px] text-[11px] font-bold text-[#8A6D1D] dark:border-[#5A4419] dark:bg-[#3A2F14] dark:text-[#E6B854]">
              <TriangleAlert size={11} strokeWidth={2.25} />
              Log every hour
            </span>
          </div>
        </div>
        {editing ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={handleCancel}
              className="whitespace-nowrap rounded-[9px] border border-[#DEE1E8] bg-white px-4 py-[9px] text-[12.5px] font-bold text-muted-foreground hover:border-[#E23D3D] hover:text-[color:var(--dd-neg)] dark:border-[#262B38] dark:bg-[#1A1E29]"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className={`whitespace-nowrap rounded-[9px] border-none px-4 py-[9px] text-[12.5px] font-bold text-white transition-colors disabled:opacity-60 ${
                saved ? 'bg-[#1C9A5B]' : 'bg-[#1B2129] hover:brightness-110 dark:bg-[#F3F4F7] dark:text-[#0A0C11]'
              }`}
            >
              {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : (
          <button
            onClick={handleEdit}
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[#DEE1E8] bg-white px-4 py-[9px] text-[12.5px] font-bold text-muted-foreground hover:border-[#5B57E0] hover:text-[#5B57E0] dark:border-[#262B38] dark:bg-[#1A1E29]"
          >
            <Pencil size={12} strokeWidth={2.25} />
            Edit
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-[10px] border border-[#EFF1F4] dark:border-[#1A1E29]">
        <table className="w-full min-w-[560px] table-fixed border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: '22%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '24%' }} />
            <col style={{ width: '20%' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="sticky left-0 z-[4] whitespace-nowrap border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2 text-left text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Date
              </th>
              <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2 text-left text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Channel
              </th>
              <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2 text-right text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Target
              </th>
              <th className="border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2 text-right text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Process
              </th>
              <th className="border-b border-l border-[#EFF1F4] bg-[#FAFBFC] px-3 py-2 text-right text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const total = (r.bkashProcess ?? 0) + (r.nagadProcess ?? 0);
              const channels = [
                { key: 'bkash' as const, label: 'Bkash', target: r.bkashTarget, process: r.bkashProcess },
                { key: 'nagad' as const, label: 'Nagad', target: r.nagadTarget, process: r.nagadProcess },
              ];
              return channels.map((c, i) => (
                <tr
                  key={`${r.date}-${c.key}`}
                  className="hover:bg-[#FAFBFC] dark:hover:bg-[#161A24]"
                >
                  {i === 0 && (
                    <td
                      rowSpan={2}
                      className="sticky left-0 z-[2] whitespace-nowrap border-b border-[#EFF1F4] bg-white px-3.5 py-2 align-top text-[12px] font-semibold text-foreground dark:border-[#1A1E29] dark:bg-[#12151D]"
                    >
                      <span className="inline-flex items-center gap-2">
                        {r.date}
                        {r.isToday && (
                          <span className="rounded-full bg-[#5B57E0] px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-[0.03em] text-white">
                            Today
                          </span>
                        )}
                      </span>
                    </td>
                  )}
                  <td className="whitespace-nowrap border-b border-[#EFF1F4] px-3 py-2 text-left text-[12.5px] text-foreground dark:border-[#1A1E29]">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground" />
                      {c.label}
                    </span>
                  </td>
                  <td className="whitespace-nowrap border-b border-[#EFF1F4] px-3 py-2 text-right text-[12.5px] text-muted-foreground dark:border-[#1A1E29]">
                    {editing ? (
                      <input
                        type="text"
                        inputMode="decimal"
                        data-date={r.date}
                        data-channel={c.key}
                        data-last-valid={c.target !== undefined ? String(c.target) : ''}
                        data-last-valid-num={c.target ?? 0}
                        defaultValue={c.target !== undefined ? c.target.toLocaleString('en-US') : ''}
                        placeholder="–"
                        onFocus={(e) => e.currentTarget.select()}
                        onInput={onTargetInput}
                        style={{ lineHeight: '18px' }}
                        className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-right text-[12.5px] tabular-nums text-foreground hover:bg-[#F1F2F5] focus:border-[#5B57E0] focus:bg-white focus:shadow-[0_0_0_3px_rgba(91,87,224,0.1)] focus:outline-none dark:hover:bg-[#1A1E29] dark:focus:bg-[#12151D]"
                      />
                    ) : (
                      // Matches the input's own box model (px-2 py-1 +
                      // lineHeight 18px) exactly — plain inline text here
                      // instead would sit shorter, making the row visibly
                      // shrink every time editing is toggled off.
                      <span style={{ lineHeight: '18px' }} className="block w-full rounded-md border border-transparent px-2 py-1 text-right tabular-nums">
                        {c.target !== undefined ? fmtWhole(c.target) : <span className="text-muted-foreground">–</span>}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap border-b border-[#EFF1F4] px-3 py-2 text-right text-[12.5px] text-foreground dark:border-[#1A1E29]">
                    {editing ? (
                      <input
                        type="text"
                        inputMode="decimal"
                        data-date={r.date}
                        data-channel={c.key}
                        data-last-valid={c.process !== undefined ? String(c.process) : ''}
                        data-last-valid-num={c.process ?? 0}
                        defaultValue={c.process !== undefined ? c.process.toLocaleString('en-US') : ''}
                        placeholder="–"
                        onFocus={(e) => e.currentTarget.select()}
                        onInput={onProcessInput}
                        style={{ lineHeight: '18px' }}
                        className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-right text-[12.5px] tabular-nums text-foreground hover:bg-[#F1F2F5] focus:border-[#5B57E0] focus:bg-white focus:shadow-[0_0_0_3px_rgba(91,87,224,0.1)] focus:outline-none dark:hover:bg-[#1A1E29] dark:focus:bg-[#12151D]"
                      />
                    ) : (
                      // Same box-model match as the Target cell above.
                      <span style={{ lineHeight: '18px' }} className="block w-full rounded-md border border-transparent px-2 py-1 text-right tabular-nums">
                        {c.process !== undefined ? fmtWhole(c.process) : <span className="text-muted-foreground">–</span>}
                      </span>
                    )}
                  </td>
                  {i === 0 && (
                    <td
                      rowSpan={2}
                      className={`whitespace-nowrap border-b border-l border-[#EFF1F4] px-3 py-2 text-right align-top text-[13px] font-extrabold text-foreground dark:border-[#1A1E29] ${
                        r.isToday ? 'bg-[#EEF2FF] dark:bg-[#1E2140]' : ''
                      }`}
                    >
                      {fmtWhole(total)}
                    </td>
                  )}
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type CashGoWallet = { channel: 'bkash' | 'nagad'; target: number | null; process: number | null };
type CashGoCompactDay = { date: string; today?: boolean; wallets: CashGoWallet[] };

// No dot+title+Last-update+Paste-badge+Edit header like the ledger cards
// above — per explicit follow-up this one drops all of that except the
// dot/title, plus a subtitle line underneath. Read-only table (no inputs,
// no paste handling) since there's no Save/Edit action on this card at all.
// Compact multi-wallet-aware layout (cashgo_compact_layout.html): one row
// per (day, wallet) instead of the previous fixed Bkash+Nagad column pair,
// with Date/Total rowSpan-ed across however many wallet rows that day has.
// Data comes from GET /api/daily-txn-entry/cashgo?history=1 — the same
// daily_txn_cashgo_entry table CashGoHourlyCard (Operations tab) writes
// "today"'s row into; the read module already curates which channels show
// per day (a channel with neither target nor process that day is omitted,
// matching the old hardcoded seed's own per-day curation) and formats each
// row's `date` as a display label ("September 12"), so this component can
// use the fetched `days` array as-is.
function CashGoDailyTargetCard() {
  const [days, setDays] = useState<CashGoCompactDay[]>([]);
  const [loading, setLoading] = useState(true);
  // "Today" for the locked month-to-date chip — the route's own
  // getEffectiveBusinessToday('cashout') (gated on that day's Estimated
  // Opening actually existing, not raw wall-clock; see its header
  // comment), never computed client-side.
  const [effectiveToday, setEffectiveToday] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch('/api/daily-txn-entry/cashgo?history=1');
      const json = await res.json();
      if (cancelled) return;
      setDays(json.days as CashGoCompactDay[]);
      setEffectiveToday(json.effectiveToday as string);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Same "KPI tiles above the table" pattern as the ledger cards
  // (LedgerCard's PgBalanceCard+StatCard grid) — but CashGo has no
  // deposit/withdrawal/opening/adjustment concept, just Target/Process per
  // wallet per day, so the equivalent summary here is a grand total plus a
  // per-wallet (Bkash/Nagad) breakdown across the whole fetched history,
  // rather than a like-for-like relabeling of the ledger tiles.
  let grandTotal = 0;
  let bkashTotal = 0;
  let nagadTotal = 0;
  for (const day of days) {
    for (const w of day.wallets) {
      const amt = w.process ?? 0;
      grandTotal += amt;
      if (w.channel === 'bkash') bkashTotal += amt;
      else nagadTotal += amt;
    }
  }

  // Splits the fetched history evenly into an "earlier half" vs "later
  // half" — the badge under Total Consume shows the % change between the
  // two, same up/down-vs-a-baseline pattern as PgBalanceCard's "vs opening"
  // badge elsewhere on this page. A day with genuinely nothing processed
  // yet (e.g. today, if not yet entered) counts as 0 — not special-cased
  // out, since it's a real (if partial) day.
  const dailyTotals = days.map((day) => day.wallets.reduce((sum, w) => sum + (w.process ?? 0), 0));
  const half = Math.floor(dailyTotals.length / 2);
  const prevWeekAvg = half > 0 ? dailyTotals.slice(0, half).reduce((a, b) => a + b, 0) / half : 0;
  const lastWeekAvg = dailyTotals.length - half > 0 ? dailyTotals.slice(half).reduce((a, b) => a + b, 0) / (dailyTotals.length - half) : 0;
  const weekTrendUp = lastWeekAvg >= prevWeekAvg;
  const weekPctChange = prevWeekAvg > 0 ? Math.abs((lastWeekAvg - prevWeekAvg) / prevWeekAvg) * 100 : 0;

  if (loading) {
    return (
      <div className="rounded-lg border border-[#DEE1E8] bg-white px-[22px] py-4 dark:border-[#262B38] dark:bg-[#12151D]">
        <div className="mb-3 flex flex-col gap-2">
          <SkeletonBar className="h-4 w-40" />
          <SkeletonBar className="h-3 w-52" />
        </div>
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1.3fr_1.3fr_1fr]">
          <SkeletonBar className="h-[66px] rounded-lg" />
          <SkeletonBar className="h-[66px] rounded-lg" />
          <div className="flex flex-col gap-2">
            <SkeletonBar className="h-[31px] rounded-lg" />
            <SkeletonBar className="h-[31px] rounded-lg" />
          </div>
        </div>
        {/* Matches the real table wrapper's own min-h/max-h exactly (see the
            non-loading render below) — this card's table is the one place
            on the page that deliberately fills leftover viewport height
            (`calc(100vh-400px)`) instead of shrinking to its row count, so a
            spinner sized only to a fixed row count would visibly grow
            taller the instant real data replaces it. */}
        <div className="relative min-h-[calc(100vh-400px)] max-h-[calc(100vh-400px)] overflow-hidden rounded-[10px] border border-[#EFF1F4] bg-white dark:border-[#1A1E29] dark:bg-[#12151D]">
          <TableLoadingSpinner overlay />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#DEE1E8] bg-white px-[22px] py-4 dark:border-[#262B38] dark:bg-[#12151D]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
            <h2 className="text-[15px] font-bold text-foreground">CashGo Daily Target</h2>
          </div>
          <p className="mt-[5px] text-[12px] text-muted-foreground">Daily record of Cashout Each day.</p>
        </div>
        {effectiveToday && (
          <DateRangeFilter
            mode="locked"
            value={{ from: effectiveToday.slice(0, 8) + '01', to: effectiveToday }}
            availableDates={[]}
            today={effectiveToday}
            onApply={() => {}}
          />
        )}
      </div>

      {/* Total Consume and Average Consume are equal-width to EACH OTHER
          (1.3fr each) and both wider than the Bkash/Nagad column (1fr) —
          per the user's own numbered mockup: 1/2 side by side and wide, 3/4
          stacked narrower on the right. Each is a lone tile in its own
          column, so the grid's default stretch still makes them exactly as
          tall as the Bkash/Nagad column's combined stacked-pair height —
          not because either one's own font is exaggerated. */}
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1.3fr_1.3fr_1fr]">
        <div className="flex flex-col rounded-lg border border-[#DEE1E8] bg-white px-4 py-2.5 dark:border-[#262B38] dark:bg-[#12151D]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Total Consume</p>
          <div className="flex flex-1 flex-col justify-center gap-1">
            <p className="text-[19px] font-semibold tabular-nums text-foreground">{fmtWhole(grandTotal)}</p>
            <p className="text-[10.5px] tabular-nums text-muted-foreground">Avg (last 7 days): {fmtWhole(lastWeekAvg)}</p>
          </div>
        </div>
        <div className="flex flex-col rounded-lg border border-[#DEE1E8] bg-white px-4 py-2.5 dark:border-[#262B38] dark:bg-[#12151D]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Average Consume</p>
          <div className="flex flex-1 flex-col justify-center gap-1.5">
            <p className="text-[19px] font-semibold tabular-nums text-foreground">{fmtWhole(lastWeekAvg)}</p>
            <span
              className="inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-[3px] text-[10.5px] tabular-nums"
              style={{
                color: weekTrendUp ? 'var(--dd-pos)' : 'var(--dd-neg)',
                background: weekTrendUp ? 'var(--dd-pos-dim)' : 'var(--dd-neg-dim)',
              }}
            >
              {weekTrendUp ? '▲' : '▼'} {weekPctChange.toFixed(1)}% · last 7 days
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-1 flex-col justify-between gap-1 rounded-lg border border-[#DEE1E8] bg-white px-4 py-2 dark:border-[#262B38] dark:bg-[#12151D]">
            <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Bkash Total</p>
            <p className="text-[15.5px] font-semibold tabular-nums text-foreground">{fmtWhole(bkashTotal)}</p>
          </div>
          <div className="flex flex-1 flex-col justify-between gap-1 rounded-lg border border-[#DEE1E8] bg-white px-4 py-2 dark:border-[#262B38] dark:bg-[#12151D]">
            <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Nagad Total</p>
            <p className="text-[15.5px] font-semibold tabular-nums text-foreground">{fmtWhole(nagadTotal)}</p>
          </div>
        </div>
      </div>

      {/* A fixed px cap (tried 480px) fixed the outer-page-scroll problem on
          a short window but left a growing dead strip of blank page below
          the card on a taller one, since the card's height stayed constant
          regardless of how much room was actually available. A viewport-
          relative cap instead — 100vh minus the space the page header, KPI
          tiles and card chrome above this wrapper actually take up (~380px,
          measured) — grows to use spare height on a tall window and still
          shrinks to avoid outer scroll on a short one. Every header cell
          gets `sticky top-0` (on top of the existing `sticky left-0` on
          Date, for horizontal scroll) so the header stays pinned while
          scrolling through whatever rows don't fit. */}
      <div className="min-h-[calc(100vh-400px)] max-h-[calc(100vh-400px)] overflow-auto rounded-[10px] border border-[#EFF1F4] dark:border-[#1A1E29]">
        <table className="w-full min-w-[560px] table-fixed border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: '22%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '24%' }} />
            <col style={{ width: '20%' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-[4] whitespace-nowrap border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-1.5 text-left text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Date
              </th>
              <th className="sticky top-0 z-[3] border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-1.5 text-left text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Channel
              </th>
              <th className="sticky top-0 z-[3] border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-1.5 text-right text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Target
              </th>
              <th className="sticky top-0 z-[3] border-b border-[#EFF1F4] bg-[#FAFBFC] px-3 py-1.5 text-right text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Process
              </th>
              <th className="sticky top-0 z-[3] border-b border-l border-[#EFF1F4] bg-[#FAFBFC] px-3 py-1.5 text-right text-[11.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground dark:border-[#1A1E29] dark:bg-[#0E1119]">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Displayed newest-first (Today at the top, working back to the
                oldest day) — `days` itself stays in chronological order
                (as returned by the API) since the 7-day-average calc above
                depends on that ordering; only this render pass reverses it. */}
            {[...days].reverse().map((day, dayIndex) => {
              const total = day.wallets.reduce((sum, w) => sum + (w.process ?? 0), 0);
              const totalIsZero = total === 0;
              return day.wallets.map((w, i) => (
                <tr
                  key={`${day.date}-${w.channel}`}
                  className={`dt-row-stagger-in group ${
                    day.today ? 'bg-[#EEF2FF] dark:bg-[#1E2140]' : 'hover:bg-[#FAFBFC] dark:hover:bg-[#161A24]'
                  }`}
                  style={{ '--stagger-delay': `${Math.min(dayIndex * 2 + i, 12) * 30}ms` } as CSSProperties}
                >
                  {i === 0 && (
                    <td
                      rowSpan={day.wallets.length}
                      className={`sticky left-0 z-[2] whitespace-nowrap border-b border-[#EFF1F4] px-3.5 py-1.5 align-top text-[12px] font-semibold text-foreground dark:border-[#1A1E29] ${
                        day.today
                          ? 'border-l-4 border-l-[#5B57E0] bg-[#EEF2FF] dark:bg-[#1E2140]'
                          : 'bg-white group-hover:bg-[#FAFBFC] dark:bg-[#12151D] dark:group-hover:bg-[#161A24]'
                      }`}
                    >
                      <span className="inline-flex items-center gap-2">
                        {day.date}
                        {day.today && (
                          <span className="rounded-[5px] bg-[#5B57E0] px-[7px] py-[2px] text-[9.5px] font-extrabold uppercase tracking-[0.04em] text-white">
                            Today
                          </span>
                        )}
                      </span>
                    </td>
                  )}
                  <td className="whitespace-nowrap border-b border-[#EFF1F4] px-3 py-1.5 text-left dark:border-[#1A1E29]">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-[3px] text-[11px] font-bold ${
                        w.channel === 'bkash'
                          ? 'bg-[#F1F3FF] text-[#2E5CE0] dark:bg-[#1B2140] dark:text-[#8FA8FF]'
                          : 'bg-[#FFF3E8] text-[#B4591F] dark:bg-[#3A2414] dark:text-[#E0965A]'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          w.channel === 'bkash' ? 'bg-[#2E5CE0] dark:bg-[#8FA8FF]' : 'bg-[#B4591F] dark:bg-[#E0965A]'
                        }`}
                      />
                      {w.channel === 'bkash' ? 'Bkash' : 'Nagad'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap border-b border-[#EFF1F4] px-3 py-1.5 text-right text-[12.5px] text-muted-foreground dark:border-[#1A1E29]">
                    {w.target !== null ? fmtWhole(w.target) : <span className="text-muted-foreground">–</span>}
                  </td>
                  <td className="whitespace-nowrap border-b border-[#EFF1F4] px-3 py-1.5 text-right text-[12.5px] text-foreground dark:border-[#1A1E29]">
                    {w.process !== null ? fmtWhole(w.process) : <span className="text-muted-foreground">–</span>}
                  </td>
                  {i === 0 && (
                    <td
                      rowSpan={day.wallets.length}
                      className={`whitespace-nowrap border-b border-l border-[#EFF1F4] px-3 py-1.5 text-right align-top dark:border-[#1A1E29] ${
                        totalIsZero ? 'text-[13px] font-semibold text-muted-foreground' : 'text-[13px] font-extrabold text-foreground'
                      } ${day.today ? 'bg-[#EEF2FF] dark:bg-[#1E2140]' : ''}`}
                    >
                      {fmtWhole(total)}
                    </td>
                  )}
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type SpySection = { id: string; label: string };

// Spy nav is Daily Entry only (see the tab === 'daily' render guard below)
// — one section per ledger card, plus the CashGo Hourly card above them.
// IDs match the `id="section-*"` attributes set on each card's own root
// element above. Order here must match render order (CashGoHourlyCard
// first, then the ledgers) so the dots read top-to-bottom in scroll order.
const DAILY_SPY_SECTIONS: SpySection[] = [
  { id: 'section-cashgo-hourly', label: 'CashGo' },
  ...LEDGERS.map((l) => ({
    id: `section-${l.id}`,
    label: l.title.split(' · ')[0],
  })),
];

// Fixed dot-track navigation — right edge, vertically centered. Tracks
// which section is currently most visible via IntersectionObserver (no
// manual scroll-offset math) and re-observes whenever `sections` changes,
// since switching tabs unmounts/remounts a completely different set of
// section elements. Clicking a dot smooth-scrolls to that section; hovering
// shows its label in a small tooltip.
function ScrollSpyDots({ sections }: { sections: SpySection[] }) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? '');
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  useEffect(() => {
    if (sections.length === 0) return;
    const scrollEl = document.querySelector('main');

    // The shrunk rootMargin below only lets a section activate once it's
    // scrolled up into the top portion of the viewport — the LAST section
    // can never satisfy that once there's no more scrollable room left
    // below it to push it up that far. Checked from BOTH the observer
    // callback and the scroll listener (whichever fires last otherwise
    // wins and can stomp the other's result), so the last dot reliably
    // wins once the page is actually scrolled to its bottom.
    function isAtBottom() {
      if (!scrollEl) return false;
      return scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (isAtBottom()) {
          setActiveId(sections[sections.length - 1].id);
          return;
        }
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        const top = visible.reduce((a, b) => (a.intersectionRatio > b.intersectionRatio ? a : b));
        setActiveId(top.target.id);
      },
      { threshold: [0.1, 0.25, 0.5, 0.75, 1], rootMargin: '-10% 0px -55% 0px' }
    );

    sections.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });

    function handleScroll() {
      if (isAtBottom()) setActiveId(sections[sections.length - 1].id);
    }
    scrollEl?.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => {
      observer.disconnect();
      scrollEl?.removeEventListener('scroll', handleScroll);
    };
  }, [sections]);

  if (sections.length === 0) return null;

  return (
    <div className="fixed right-2 top-1/2 z-40 -translate-y-1/2 sm:right-5">
      <div className="relative flex flex-col items-center gap-4 py-2">
        {/* Track line — purely decorative, sits behind the dots. */}
        <div className="pointer-events-none absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-[#DEE1E8] dark:bg-[#262B38]" />
        {sections.map((s) => {
          const active = s.id === activeId;
          return (
            <div key={s.id} className="group relative flex items-center justify-center">
              {hoveredId === s.id && (
                <span className="pointer-events-none absolute right-[16px] top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-[#DEE1E8] bg-white px-2 py-1 text-[11px] font-medium text-foreground shadow-md dark:border-[#262B38] dark:bg-[#12151D]">
                  {s.label}
                </span>
              )}
              <button
                type="button"
                aria-label={`Scroll to ${s.label}`}
                onClick={() => {
                  // Set the active dot immediately on click, rather than
                  // waiting for the IntersectionObserver to notice — a tall
                  // card centered via `block: 'center'` often only needs a
                  // short scroll, which can land entirely inside the shrunk
                  // rootMargin band below (tuned to fix the "last dot never
                  // activates" bug) without ever crossing into or out of it.
                  // When that happens the observer never fires again, so
                  // the dot silently stays on whatever was active before
                  // the click — reproduced with SSP Line 1 specifically
                  // (its card starts close enough to a centered position
                  // that the resulting scroll distance was too short for
                  // the observer to register a change).
                  setActiveId(s.id);
                  document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
                onMouseEnter={() => setHoveredId(s.id)}
                onMouseLeave={() => setHoveredId(null)}
                className={`relative z-10 shrink-0 rounded-full transition-all duration-200 ${
                  active
                    ? 'h-[10px] w-[10px] bg-[#5B57E0] ring-4 ring-[#5B57E0]/20 dark:bg-[#8B87FF] dark:ring-[#8B87FF]/25'
                    : 'h-2 w-2 bg-[#C7CCD6] hover:bg-[#9CA3AF] dark:bg-[#3A3F4B] dark:hover:bg-[#565C70]'
                }`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DailyTxnEntryPage() {
  const { theme, toggleTheme } = useTheme();
  const [, setAutosaveLabel] = useState('Autosaved just now');
  const [tab, setTab] = useState<'daily' | 'pg' | 'cashgo' | 'estimated'>('daily');
  const [spinning, setSpinning] = useState(false);

  // Restores whichever tab was last active, but ONLY across an actual
  // browser reload of this page (F5, or the Refresh button below, which is
  // itself a full reload) — per explicit follow-up instruction, arriving
  // here fresh via a sidebar/link click (SPA route change, no document
  // reload) must always land on Operations, never on whatever tab happened
  // to be saved from a previous visit. Reload vs SPA-navigation is told
  // apart via sessionStorage: a `beforeunload` listener (effect further
  // below) stamps a "reloading" flag immediately before any real document
  // unload — Next's client-side route transitions never fire
  // `beforeunload` (no document unload happens), so the flag is only ever
  // present when this exact page is about to genuinely reload. On mount,
  // that flag (if present) is consumed once, and the saved tab is restored
  // only in that case; otherwise this stays on the 'daily' (Operations)
  // default. A useLayoutEffect (not useEffect) so the correction — when it
  // does apply, i.e. on an actual reload — happens synchronously before
  // the browser paints, avoiding a visible flash/jump from 'daily' to
  // whatever was actually saved.
  //
  // The write side is intentionally NOT a mirroring useEffect keyed on
  // `tab` — selectTab() below writes to localStorage directly, at the same
  // moment it calls setTab(). An effect approach was tried first and had a
  // real race: React (in dev, under Strict Mode's double-invoke) can still
  // run a stale passive effect closure captured from the pre-restore render
  // (tab still 'daily') *after* this layout effect has already corrected
  // the visible tab — that stale effect writes 'daily' back over the
  // correct saved value, and Strict Mode's second pass then reads that
  // clobbered value and reverts the tab the user actually sees. Writing
  // synchronously at the click site has no render-order ambiguity to race.
  useLayoutEffect(() => {
    const wasReloading = window.sessionStorage.getItem('daily-txn-entry:reloading') === '1';
    window.sessionStorage.removeItem('daily-txn-entry:reloading');
    if (!wasReloading) return; // fresh SPA navigation into the page — stay on Operations
    const saved = window.localStorage.getItem('daily-txn-entry:tab');
    if (saved === 'daily' || saved === 'pg' || saved === 'cashgo' || saved === 'estimated') setTab(saved);
  }, []);

  // Stamps the "about to reload" flag right before any genuine full-page
  // unload while this page is mounted — see the layout effect above for
  // why this (not the Navigation Timing API, which stays stale across
  // later SPA transitions into this page) is what actually distinguishes
  // "user refreshed this page" from "user clicked into this page".
  useEffect(() => {
    function handleBeforeUnload() {
      window.sessionStorage.setItem('daily-txn-entry:reloading', '1');
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  function selectTab(next: 'daily' | 'pg' | 'cashgo' | 'estimated') {
    setTab(next);
    window.localStorage.setItem('daily-txn-entry:tab', next);
  }

  // No live backend to refetch from (see NOTE below) — Refresh reloads the
  // page outright, which naturally resets every ledger back to its
  // hardcoded seed data. Same 600ms min-spin convention as the rest of the
  // app's Refresh buttons, so the icon doesn't just flash instantly.
  function handleRefresh() {
    setSpinning(true);
    setTimeout(() => window.location.reload(), 600);
  }

  // Purely decorative confirmation text, same as the reference file's
  // pulseAutosave() — no real persistence backs this yet (see NOTE below).
  function pulseAutosave() {
    setAutosaveLabel('Autosaved just now');
  }

  return (
    <div
      data-tab={tab}
      className={`dd-page min-h-screen bg-[#F7F8FA] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#0A0C11] dark:text-white ${manrope.variable} ${spaceGrotesk.variable}`}
    >
      {/* PG Balances keeps the plain native scrollbar and no dots — the
          spy nav (and the scrollbar-hide rule below) are Daily Entry only,
          per explicit follow-up. */}
      {tab === 'daily' && <ScrollSpyDots key={tab} sections={DAILY_SPY_SECTIONS} />}
      {/* Same page-scoped token block as app/page.tsx's own .dd-page style —
          see the comment there for why these are defined per-page instead
          of globally (exact demo hex, distinct from the app-wide design
          tokens used elsewhere). Font rules are this page's own explicit
          exception to the app-wide Inter rule (see the font-loader comment
          up top) — Manrope for everything, Space Grotesk for anything
          carrying `.tabular-nums` (i.e. every numeric value on this page). */}
      <style>{`
        .dd-page :where(h1, h2, h3, p, span, td, th) { line-height: normal; }
        .dd-page {
          --dd-pos: #16A34A; --dd-neg: #E23D3D; --dd-pos-dim: rgba(22,163,74,.10); --dd-neg-dim: rgba(226,61,61,.10);
          --ink-0: #F7F8FA; --ink-1: #FFFFFF; --ink-2: #F1F2F5; --hair: #DDE0E7;
          --text-hi: #1A1D23; --text-mid: #6B7280; --text-low: #9CA3AF;
          font-family: var(--font-manrope), ui-sans-serif, system-ui, sans-serif;
        }
        .dark .dd-page {
          --dd-pos: #34D399; --dd-neg: #F4665A; --dd-pos-dim: rgba(52,211,153,.12); --dd-neg-dim: rgba(244,102,90,.12);
          --ink-0: #0A0C11; --ink-1: #12151D; --ink-2: #1A1E29; --hair: #262B38;
          --text-hi: #F3F4F7; --text-mid: #9198AC; --text-low: #565C70;
        }
        .dd-page .tabular-nums { font-family: var(--font-space-grotesk), ui-monospace, monospace; }
        /* Daily Entry only: the scrollspy dots already show scroll position,
           so the native scrollbar is redundant there — made fully
           transparent (never actually removed from layout) rather than
           hidden via scrollbar-width:none/display:none, which also cancels
           AppShell's scrollbar-gutter:stable reservation on <main> and was
           making the header visibly shift/narrow every time this tab and
           Report (which keeps its normal, reserved scrollbar) were
           switched between. Keeping the same reserved width on both tabs
           — just invisible on this one — is what actually fixes that. */
        main:has(.dd-page[data-tab="daily"]) {
          scrollbar-color: transparent transparent;
        }
        main:has(.dd-page[data-tab="daily"])::-webkit-scrollbar-thumb,
        main:has(.dd-page[data-tab="daily"])::-webkit-scrollbar-track {
          background: transparent;
        }
        /* AppShell's <main> has no background of its own, so the reserved
           scrollbar-gutter strip (and any other bare sliver of <main>) was
           showing globals.css's own light page gradient bleed through —
           invisible normally since an opaque scrollbar painted over it, but
           impossible to miss once that scrollbar was made transparent
           above. Matches .dd-page's own --ink-0 token value (hardcoded here
           since CSS custom properties don't inherit upward from a
           descendant to this ancestor). */
        main:has(.dd-page) {
          background: #F7F8FA;
        }
        .dark main:has(.dd-page) {
          background: #0A0C11;
        }
      `}</style>
      <main className="px-4 pb-6 md:px-[28px] md:pb-8">
        <div className="mx-auto max-w-[1400px] pt-4">
          <PageHeader
            title="Daily Transaction Entry"
            containerless
            stickyOffset={16}
            actions={
              <>
                <button
                  onClick={handleRefresh}
                  disabled={spinning}
                  aria-label="Refresh"
                  title="Refresh"
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] bg-[#F1F2F5] text-[#6B7280] hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)] disabled:opacity-50 dark:border-[#262B38] dark:bg-[#1A1E29] dark:text-[#9198AC]"
                >
                  {/* Same hand-drawn icon as Operations Overview's own
                      Refresh button (ported from WaveTrendChart's "Replay
                      animation" icon) — kept pixel-identical rather than a
                      lucide equivalent. */}
                  <svg
                    viewBox="0 0 16 16"
                    width="11"
                    height="11"
                    fill="none"
                    className={spinning ? 'animate-spin' : ''}
                    style={{ color: spinning ? 'var(--ui-accent)' : undefined }}
                  >
                    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    <path d="M13.5 2.3V6h-3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  onClick={toggleTheme}
                  aria-label="Toggle light and dark mode"
                  title="Toggle light and dark mode"
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[#DEE1E8] bg-[#F1F2F5] text-[#6B7280] hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)] dark:border-[#262B38] dark:bg-[#1A1E29] dark:text-[#9198AC]"
                >
                  {theme === 'dark' ? <Sun size={11} /> : <Moon size={11} />}
                </button>
                <AccountMenu compact />
              </>
            }
          />

          {/* Pill/badge tab switcher — mimics the reference screenshot's
              switcher style exactly (bordered white pill idle, tinted-indigo
              pill active), same rounded-full badge convention used
              elsewhere in this app rather than an underlined tab bar. */}
          <div className="mb-4 flex items-center gap-2">
            {PAGE_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => selectTab(t.key)}
                className={`rounded-[8px] border px-3.5 py-1.5 text-[12px] transition-colors ${
                  tab === t.key
                    ? 'border-[#C7D2FE] bg-[#EEF2FF] font-medium text-[#4F46E5] dark:border-[#3A3F6B] dark:bg-[#1E2140] dark:text-[#A5B4FC]'
                    : 'border-[#DEE1E8] bg-white font-normal text-muted-foreground hover:bg-[#F1F2F5] dark:border-[#262B38] dark:bg-[#12151D] dark:hover:bg-[#1A1E29]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'daily' ? (
            <div className="flex flex-col gap-5">
              <CashGoHourlyCard onActivity={pulseAutosave} />
              {LEDGERS.map((def) => (
                <LedgerCard key={def.id} def={def} onActivity={pulseAutosave} />
              ))}
            </div>
          ) : tab === 'pg' ? (
            <div className="flex flex-col gap-5">
              <div id="section-wallet-breakdown" className="scroll-mt-6">
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                  Wallet Breakdown Opening
                </h2>
                <div className="flex flex-wrap gap-4">
                  <YesterdayClosingCard ledgerId="ssp1" title="SSP Line1 · Cashout" onActivity={pulseAutosave} />
                  <YesterdayClosingCard ledgerId="ssp2" title="SSP Line2 · Send Money" onActivity={pulseAutosave} />
                </div>
              </div>
              <div className="scroll-mt-6">
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                  Payment Gateway Opening
                </h2>
                <PgClosingBalancesCard onActivity={pulseAutosave} />
              </div>
            </div>
          ) : tab === 'cashgo' ? (
            <div className="flex flex-col gap-5">
              <CashGoDailyTargetCard />
            </div>
          ) : (
            <EstimatedTabContent />
          )}
        </div>
      </main>
    </div>
  );
}
