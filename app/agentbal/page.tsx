'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Download, Filter, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import ThemeToggle from '../components/ThemeToggle';
import ConnectionErrorState from '../components/ConnectionErrorState';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../lib/errors';
import { rawVal } from '@/app/lib/format';
import { getBusinessToday, toBusinessDate, parseCardCutoffDate } from '../lib/businessDate';

type OpeningRow = {
  agentName: string;
  openingBal: string;
  sdp: string;
  leader: string;
};

type MergedRow = OpeningRow & {
  agentTotalDP: number;
  agentTotalWD: number;
  totalTopUp: number;
  totalStlm: number;
  balanceInside: number;
  runningBalance: number;
  agentWithdrawal: number;
  sdpVsBalance: number;
  walletStatus: string;
  brand: string;
  walletType: string;
};

function parseCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentField);
      currentField = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i += 1;
      }
      currentRow.push(currentField);
      if (currentRow.some((cell) => cell.trim() !== '')) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
      continue;
    }

    currentField += char;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some((cell) => cell.trim() !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function displayNum(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return '−';

  let num: number;
  if (typeof val === 'number') {
    num = val;
  } else {
    const cleaned = val.replace(/"/g, '').replace(/,/g, '').trim();
    if (cleaned === '-' || cleaned === '') return '−';
    num = parseFloat(cleaned);
  }

  if (isNaN(num) || Math.abs(num) < 0.01) return '−';

  const formatted = Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `-${formatted}` : formatted;
}

function numOrBlank(num: number): number | undefined {
  return Math.abs(num) < 0.01 ? undefined : num;
}

function fmt(num: number): string {
  return Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtAbbrev(num: number): string {
  const abs = Math.abs(num);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(2)}K`;
  return abs.toFixed(2);
}

function parseNumber(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// Opening sheet col G holds a "REPORT LAST UPDATE" card, e.g. "July 2 - 8:54 AM".
// This is the cutoff: Top Up / Settlement totals should only include rows dated
// on or after this reset point, so entries already folded into the last Opening
// Balance reset aren't double-counted.
function parseReportCutoffDate(openingRawRows: string[][]): Date | null {
  for (const row of openingRawRows) {
    const parsed = parseCardCutoffDate(row[6] ?? '');
    if (parsed) return parsed;
  }
  return null;
}

// Stlm Top Up sheet dates are formatted "M/D/YYYY".
function parseSheetDate(dateStr: string): Date | null {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

function normalizeWalletStatus(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const lower = trimmed.toLowerCase();
  const noSpaces = trimmed.replace(/\s+/g, '').toLowerCase();
  if (noSpaces.includes('dp+wd')) return 'DP+WD';
  if (lower.includes('dp only')) return 'DP Only';
  if (lower.includes('wd only')) return 'WD Only';
  if (lower.includes('top up')) return 'Top Up Acc.';
  if (lower.includes('wallet with issue')) return 'Wallet With Issue';
  if (lower.includes('x group') || lower.includes('disconnected')) return 'Disconnected';
  if (lower.includes('check account problem')) return 'Account Problem';
  return 'Disconnected';
}

function computeWalletStatus(statuses: string[]): string {
  const normalized = statuses
    .map((s) => normalizeWalletStatus(s))
    .filter((s): s is string => s !== null);

  if (normalized.length === 0) return 'Disconnected';

  const has = (label: string) => normalized.includes(label);

  if (has('DP+WD')) return 'DP + WD';
  if (has('DP Only') && has('WD Only')) return 'DP + WD';
  if (has('DP Only')) return 'DP Only';
  if (has('WD Only')) return 'WD Only';
  if (has('Top Up Acc.')) return 'Top Up Acc.';
  if (has('Wallet With Issue')) return 'Wallet With Issue';
  if (has('Account Problem')) return 'Account Problem';

  return 'Disconnected';
}

const WALLET_STATUS_OPTIONS = ['DP + WD', 'DP Only', 'WD Only', 'Top Up Acc.', 'Wallet With Issue', 'Disconnected', 'Account Problem', 'No Record'];

const WALLET_TYPE_ORDER = [
  { match: 'BKASH', abbreviation: 'BK' },
  { match: 'NAGAD', abbreviation: 'NG' },
  { match: 'ROCKET', abbreviation: 'RK' },
  { match: 'UPAY', abbreviation: 'UP' },
];

function computeWalletType(types: string[]): string {
  const normalized = new Set(types.map((raw) => raw.trim().toUpperCase()).filter((t) => t && t !== '-'));

  const abbreviations = WALLET_TYPE_ORDER
    .filter(({ match }) => normalized.has(match))
    .map(({ abbreviation }) => abbreviation);

  return abbreviations.length > 0 ? abbreviations.join(' | ') : '−';
}

const WALLET_TYPE_FILTER_OPTIONS = [
  { label: 'Bkash', abbreviation: 'BK' },
  { label: 'Nagad', abbreviation: 'NG' },
  { label: 'Rocket', abbreviation: 'RK' },
  { label: 'UPay', abbreviation: 'UP' },
];

const WALLET_TYPE_FILTER_LABELS = [...WALLET_TYPE_FILTER_OPTIONS.map((opt) => opt.label), '—'];

const EXCLUDED_SDP_LEADERS = [
  'AFF JAR', 'AIMAN', 'ALADDIN', 'JISAN', 'MIR', 'MR LEE',
  'MUNIM', 'NIHJUM', 'NURNOBY', 'ONEMEN', 'OSMAN', 'MOTIN',
  'ROSE', 'SAM', 'XYZ', 'SHAKIL', 'SHARIF', 'SVEN', 'TANVIR', 'ZUBAIR'
];

function computeSdpVsBalance(leader: string, sdpRaw: string, sdpNum: number, companyBalance: number): number {
  const normalizedLeader = leader.trim().toUpperCase();
  if (EXCLUDED_SDP_LEADERS.includes(normalizedLeader)) return 0;

  const sdpTrimmed = sdpRaw.trim().toUpperCase();
  const value = sdpTrimmed === 'NO SDP' || sdpNum === 0 ? companyBalance : companyBalance - sdpNum;

  if (value < 30000) return 0;
  if (companyBalance <= 0) return 0;

  return value;
}

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

// "To Agent" values on "AG BD STLM + TOPUP" sometimes carry a trailing
// "-<brand>" suffix (e.g. "KONAN001-M1"), sometimes not (e.g. "YUJI024") —
// strip it so the bare code matches Opening AG's own (always-bare) agent names.
function stripBrandSuffix(name: string): string {
  const parts = name.split('-');
  if (parts.length >= 2 && BRAND_CODES.includes(parts[parts.length - 1].toUpperCase())) {
    return parts.slice(0, -1).join('-');
  }
  return name;
}

type ColumnKey = 'brand' | 'leader' | 'walletName' | 'walletType' | 'sdp' | 'opening' | 'totalDP' | 'totalWD' | 'topUp' | 'settlement' | 'companyBalance' | 'balanceInside' | 'agentWithdrawal' | 'sdpVsBalance' | 'walletStatus';

const columnDefs: { key: ColumnKey; label: string; sortable: boolean }[] = [
  { key: 'brand', label: 'Brand', sortable: false },
  { key: 'leader', label: 'Leader', sortable: false },
  { key: 'walletName', label: 'Shop Name', sortable: true },
  { key: 'walletType', label: 'Type', sortable: false },
  { key: 'sdp', label: 'SDP', sortable: true },
  { key: 'opening', label: 'Opening', sortable: true },
  { key: 'totalDP', label: 'Total DP', sortable: true },
  { key: 'totalWD', label: 'Total WD', sortable: true },
  { key: 'topUp', label: 'Top Up', sortable: true },
  { key: 'settlement', label: 'Settlement', sortable: true },
  { key: 'companyBalance', label: 'Company Balance', sortable: true },
  { key: 'balanceInside', label: 'Balance Inside', sortable: true },
  { key: 'agentWithdrawal', label: 'Agent Withdrawal', sortable: true },
  { key: 'sdpVsBalance', label: 'SDP VS Balance', sortable: true },
  { key: 'walletStatus', label: 'Wallet Status', sortable: false },
];

const columnWidths: Record<ColumnKey, string> = {
  brand: '70px',
  leader: '90px',
  walletName: '140px',
  walletType: '110px',
  sdp: '105px',
  opening: '105px',
  totalDP: '105px',
  totalWD: '105px',
  topUp: '105px',
  settlement: '105px',
  companyBalance: '130px',
  balanceInside: '120px',
  agentWithdrawal: '135px',
  sdpVsBalance: '130px',
  walletStatus: '125px',
};

const TABLE_MIN_WIDTH = '1680px';

const STICKY_COLS: ColumnKey[] = [];
const DEFAULT_HIDDEN: ColumnKey[] = ['brand', 'sdp', 'settlement', 'topUp', 'sdpVsBalance'];

// Fixed display order for the mobile card's balances grid.
const BALANCE_GRID_ORDER: ColumnKey[] = [
  'balanceInside', 'agentWithdrawal', 'opening',
  'totalWD', 'topUp', 'totalDP',
  'settlement', 'sdp', 'sdpVsBalance',
];

function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  if (!active) {
    return (
      <span className="flex flex-col items-center justify-center leading-none text-slate-400 opacity-40">
        <ChevronUp size={10} className="-mb-0.5" />
        <ChevronDown size={10} />
      </span>
    );
  }
  return direction === 'asc' ? (
    <ChevronUp size={10} className="text-indigo-600 dark:text-indigo-400" />
  ) : (
    <ChevronDown size={10} className="text-indigo-600 dark:text-indigo-400" />
  );
}

function headerCellClasses(_colKey: ColumnKey, _isSorted: boolean) {
  return `text-center px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] whitespace-nowrap text-muted-foreground`;
}

function walletStatusBadgeClasses(status: string): string {
  switch (status) {
    case 'DP + WD':
    case 'DP Only':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-900/50';
    case 'WD Only':
      return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-900/50';
    case 'Top Up Acc.':
      return 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-400 dark:border-indigo-900/50';
    case 'Wallet With Issue':
    case 'Account Problem':
      return 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-900/50';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-700';
  }
}

// Mobile card grid fields — mirrors renderCell's data + colors, minus the
// columns (walletName, walletStatus, companyBalance) shown in the card header/hero.
function mobileCardFieldValue(row: MergedRow, key: ColumnKey): { value: string; className: string } {
  switch (key) {
    case 'brand':
      return { value: row.brand, className: 'text-foreground' };
    case 'leader':
      return { value: row.leader, className: 'text-muted-foreground' };
    case 'walletType':
      return { value: row.walletType, className: 'text-muted-foreground' };
    case 'sdp':
      return { value: displayNum(row.sdp), className: 'text-foreground' };
    case 'opening':
      return { value: displayNum(row.openingBal), className: 'text-foreground' };
    case 'totalDP':
      return { value: displayNum(row.agentTotalDP), className: 'text-emerald-600 dark:text-emerald-400' };
    case 'totalWD':
      return { value: displayNum(row.agentTotalWD), className: 'text-rose-600 dark:text-rose-400' };
    case 'topUp':
      return { value: displayNum(row.totalTopUp), className: 'text-teal-600 dark:text-teal-400' };
    case 'settlement':
      return { value: displayNum(row.totalStlm), className: 'text-orange-500 dark:text-orange-400' };
    case 'balanceInside':
      return { value: displayNum(String(row.balanceInside ?? 0)), className: 'text-foreground' };
    case 'agentWithdrawal':
      return { value: displayNum(String(row.agentWithdrawal)), className: 'text-foreground' };
    case 'sdpVsBalance':
      return { value: row.sdpVsBalance > 0 ? displayNum(String(Math.abs(row.sdpVsBalance))) : '−', className: 'text-foreground' };
    default:
      return { value: '−', className: 'text-foreground' };
  }
}

function renderCell(row: MergedRow, key: ColumnKey) {

  const base = 'whitespace-nowrap overflow-hidden text-ellipsis px-3 py-1.5 text-[11px]';

  switch (key) {
    case 'brand':
      return <td key={key} className={`${base} text-center font-semibold text-foreground`}>{row.brand}</td>;
    case 'leader':
      return <td key={key} className={`${base} text-center text-muted-foreground`}>{row.leader}</td>;
    case 'walletName':
      return <td key={key} className={`${base} text-center font-semibold text-foreground`}>{row.agentName}</td>;
    case 'walletType':
      return <td key={key} className={`${base} text-center text-muted-foreground`}>{row.walletType}</td>;
    case 'sdp':
      return <td key={key} className={`${base} text-center tabular-nums text-foreground`}>{displayNum(row.sdp)}</td>;
    case 'opening':
      return <td key={key} className={`${base} text-center tabular-nums text-foreground`}>{displayNum(row.openingBal)}</td>;
    case 'totalDP':
      return <td key={key} className={`${base} text-center tabular-nums font-medium text-emerald-600 dark:text-emerald-400`}>{displayNum(row.agentTotalDP)}</td>;
    case 'totalWD':
      return <td key={key} className={`${base} text-center tabular-nums font-medium text-rose-600 dark:text-rose-400`}>{displayNum(row.agentTotalWD)}</td>;
    case 'topUp':
      return <td key={key} className={`${base} text-center tabular-nums text-teal-600 dark:text-teal-400`}>{displayNum(row.totalTopUp)}</td>;
    case 'settlement':
      return <td key={key} className={`${base} text-center tabular-nums text-orange-500 dark:text-orange-400`}>{displayNum(row.totalStlm)}</td>;
    case 'balanceInside':
      return <td key={key} className={`${base} text-center tabular-nums text-foreground`}>{displayNum(String(row.balanceInside ?? 0))}</td>;
    case 'agentWithdrawal':
      return <td key={key} className={`${base} text-center tabular-nums text-foreground`}>{displayNum(String(row.agentWithdrawal))}</td>;
    case 'sdpVsBalance':
      return <td key={key} className={`${base} text-center tabular-nums text-foreground`}>{row.sdpVsBalance > 0 ? displayNum(String(Math.abs(row.sdpVsBalance))) : '−'}</td>;
    case 'walletStatus':
      return <td key={key} className={`${base} text-center text-foreground`}>{row.walletStatus}</td>;
    case 'companyBalance':
    default: {
      const v = displayNum(row.runningBalance);
      const color = v !== '−' && row.runningBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground';
      return <td key={key} className={`${base} text-center tabular-nums font-bold ${color}`}>{v}</td>;
    }
  }
}

export default function AgentBalance() {
  const [rows, setRows] = useState<MergedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [cardsExpanded, setCardsExpanded] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [leaderFilter, setLeaderFilter] = useState<Record<string, boolean>>({});
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [walletTypeFilter, setWalletTypeFilter] = useState<Record<string, boolean>>({});
  const [sortColumn, setSortColumn] = useState<ColumnKey>('companyBalance');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [filterMenuPos, setFilterMenuPos] = useState({ top: 0, left: 0 });
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [brandMenuPos, setBrandMenuPos] = useState({ top: 0, left: 0 });
  const [leaderMenuOpen, setLeaderMenuOpen] = useState(false);
  const [leaderMenuPos, setLeaderMenuPos] = useState({ top: 0, left: 0 });
  const [walletTypeMenuOpen, setWalletTypeMenuOpen] = useState(false);
  const [walletTypeMenuPos, setWalletTypeMenuPos] = useState({ top: 0, left: 0 });
  const [walletStatusMenuOpen, setWalletStatusMenuOpen] = useState(false);
  const [walletStatusMenuPos, setWalletStatusMenuPos] = useState({ top: 0, left: 0 });
  const [columnVisibility, setColumnVisibility] = useState<Record<ColumnKey, boolean>>(
    () => Object.fromEntries(columnDefs.map((col) => [col.key, !DEFAULT_HIDDEN.includes(col.key)])) as Record<ColumnKey, boolean>
  );
  const [walletStatusFilter, setWalletStatusFilter] = useState<Record<string, boolean>>(
    () => Object.fromEntries(WALLET_STATUS_OPTIONS.map((status) => [status, true]))
  );
  const [page, setPage] = useState(1);
  const rowsPerPage = 50;
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandDropdownRef = useRef<HTMLDivElement>(null);
  const leaderButtonRef = useRef<HTMLButtonElement>(null);
  const leaderDropdownRef = useRef<HTMLDivElement>(null);
  const walletTypeButtonRef = useRef<HTMLButtonElement>(null);
  const walletTypeDropdownRef = useRef<HTMLDivElement>(null);
  const walletStatusButtonRef = useRef<HTMLButtonElement>(null);
  const walletStatusDropdownRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<number>(0);

  const fetchData = useCallback(async () => {
    scrollRef.current = window.scrollY;
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      const [openingRes, balRes, stlmRes, estimatedRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/balance-limit?t=${Date.now()}`),
        fetch(`/api/agstlmtopup?t=${Date.now()}`),
        fetch(`/api/opening/estimated-balance?t=${Date.now()}`),
      ]);

      await assertAllOk([openingRes, balRes, stlmRes, estimatedRes]);

      const openingText = await openingRes.text();
      const balData: string[][] = await balRes.json();
      const stlmText = await stlmRes.text();
      const estimatedData: { balances: Record<string, number>; uploadedAt: string | null } = await estimatedRes.json();

      const openingRawRows = parseCsvLines(openingText);
      // Opening's own "Updated Time" card — kept separate from the Top
      // Up/Settlement cutoff below (which is purely clock-based). This one
      // is still needed to detect whether Opening AG has been manually
      // refreshed yet, for the Assumed Balance validity check further down.
      const reportCutoffDate = parseReportCutoffDate(openingRawRows);
      // Top Up/Settlement totals (feeding Company Balance) reset at the 2AM
      // business-day rollover (see app/lib/businessDate.ts) — clock-based,
      // independent of whether Opening's own "Updated Time" card has been
      // manually refreshed.
      const topUpSettlementCutoff = getBusinessToday();

      // Assumed Balance (uploaded via Opening's "Upload Excel Data") only
      // takes over when BOTH hold:
      // 1. Opening's own "Updated Time" card is still showing the PREVIOUS
      //    business day — i.e. the real Opening reset for today hasn't
      //    happened yet. The instant "Updated Time" catches up to today,
      //    this stops applying on its own (no manual delete needed).
      // 2. The upload's OWN "Last Updated" timestamp is itself from TODAY's
      //    business day — a fresh upload made right around/after the 2AM
      //    rollover reads as "today" already (see app/lib/businessDate.ts).
      //    An upload left over from a prior business day (stale — no fresh
      //    file was uploaded for today) must NOT keep being applied just
      //    because Opening's own reset happens to be running late too.
      const estimatedUploadedAt = estimatedData.uploadedAt ? new Date(estimatedData.uploadedAt) : null;
      const estimatedOpeningValid =
        reportCutoffDate !== null &&
        reportCutoffDate.getTime() < getBusinessToday().getTime() &&
        estimatedUploadedAt !== null &&
        toBusinessDate(estimatedUploadedAt).getTime() === getBusinessToday().getTime();
      const estimatedBalances = new Map(Object.entries(estimatedData.balances ?? {}));

      const openingRows = openingRawRows
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: rawVal(row[0]),
          openingBal: rawVal(row[1]),
          sdp: rawVal(row[2]),
          leader: rawVal(row[3]),
        }))
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD')
        .map((row) => {
          if (!estimatedOpeningValid) return row;
          const assumedBalance = estimatedBalances.get(row.agentName);
          return assumedBalance === undefined ? row : { ...row, openingBal: String(assumedBalance) };
        });

      const balRows = balData
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          walletName: rawVal(row[1]),
          walletType: rawVal(row[4]),
          totalDP: rawVal(row[11]),
          totalWD: rawVal(row[13]),
          balance: rawVal(row[8]),
          login: rawVal(row[15]),
          accountStatus: rawVal(row[2]),
          group: rawVal(row[6]),
        }))
        .filter((row) => row.walletName && row.walletName !== '-');

      const balWalletNames = new Set(balRows.map((bal) => bal.walletName));
      const balanceTotals = new Map<string, { dp: number; wd: number }>();
      const balanceInsideTotals = new Map<string, number>();
      const walletStatusValues = new Map<string, string[]>();
      const brandGroups = new Map<string, string[]>();
      const walletTypeValues = new Map<string, string[]>();
      balRows.forEach((bal) => {
        const name = bal.walletName;
        const dp = parseFloat(bal.totalDP.replace(/,/g, '')) || 0;
        const wd = parseFloat(bal.totalWD.replace(/,/g, '')) || 0;
        const existing = balanceTotals.get(name) ?? { dp: 0, wd: 0 };
        balanceTotals.set(name, {
          dp: existing.dp + dp,
          wd: existing.wd + wd,
        });

        if (bal.group && bal.group !== '-') {
          const groups = brandGroups.get(name) ?? [];
          groups.push(bal.group);
          brandGroups.set(name, groups);
        }

        if (bal.accountStatus && bal.accountStatus !== '-') {
          const statuses = walletStatusValues.get(name) ?? [];
          statuses.push(bal.accountStatus);
          walletStatusValues.set(name, statuses);
        }

        if (bal.walletType && bal.walletType !== '-' && bal.login.trim().toLowerCase() === 'yes') {
          const types = walletTypeValues.get(name) ?? [];
          types.push(bal.walletType);
          walletTypeValues.set(name, types);
        }

        if (bal.login.trim().toLowerCase() === 'yes') {
          const balance = parseFloat(bal.balance.replace(/,/g, '')) || 0;
          balanceInsideTotals.set(name, (balanceInsideTotals.get(name) ?? 0) + balance);
        }
      });

      // "AG BD STLM + TOPUP" is Cashout's own dedicated Settlement + Top Up
      // sheet (replaces the old shared "Stlm Top Up" source). Top Up lives
      // in cols B-F (indices 1-5): To Agent/Amount/Date/Wallet/Type (the
      // sheet's own header row mislabels cols D/E as "Wallet"/"Date" — the
      // actual data order matches this, confirmed by sampling), amounts
      // stored positive. Settlement lives in cols H-L (indices 7-11), same
      // field order, amounts stored negative (money leaving) so they're
      // abs()'d. Cols Q-AA are a last-month archive and are not read.
      const topUpTotals = new Map<string, number>();
      const stlmTotals = new Map<string, number>();
      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const topUpAgent = stripBrandSuffix(rawVal(row[1]));
          const topUpAmount = rawVal(row[2]);
          const topUpDate = parseSheetDate(rawVal(row[3]));
          if (
            topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-' &&
            topUpDate && topUpDate >= topUpSettlementCutoff
          ) {
            const amount = Math.abs(parseFloat(topUpAmount.replace(/,/g, '')) || 0);
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
          }

          const stlmAgent = stripBrandSuffix(rawVal(row[7]));
          const stlmAmount = rawVal(row[8]);
          const stlmDate = parseSheetDate(rawVal(row[9]));
          if (
            stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-' &&
            stlmDate && stlmDate >= topUpSettlementCutoff
          ) {
            const amount = Math.abs(parseFloat(stlmAmount.replace(/,/g, '')) || 0);
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + amount);
          }
        });

      const merged: MergedRow[] = openingRows.map((opening) => {
        const totals = balanceTotals.get(opening.agentName) ?? { dp: 0, wd: 0 };
        const totalTopUp = topUpTotals.get(opening.agentName) ?? 0;
        const totalStlm = stlmTotals.get(opening.agentName) ?? 0;
        const balanceInside = balanceInsideTotals.get(opening.agentName) ?? 0;
        const runningBalance = parseNumber(opening.openingBal) + totals.dp + totalTopUp - totals.wd - totalStlm;
        const sdpNum = parseNumber(opening.sdp);
        const walletStatus = balWalletNames.has(opening.agentName)
          ? computeWalletStatus(walletStatusValues.get(opening.agentName) ?? [])
          : 'No Record';
        return {
          ...opening,
          agentTotalDP: totals.dp,
          agentTotalWD: totals.wd,
          totalTopUp,
          totalStlm,
          balanceInside,
          runningBalance,
          agentWithdrawal: runningBalance - balanceInside,
          sdpVsBalance: computeSdpVsBalance(opening.leader, opening.sdp, sdpNum, runningBalance),
          walletStatus,
          brand: resolveBrand(brandGroups.get(opening.agentName) ?? [], opening.agentName),
          walletType: computeWalletType(walletTypeValues.get(opening.agentName) ?? []),
        };
      });

      setRows(merged);
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.scrollTo({ top: scrollRef.current, behavior: 'instant' });
          });
        });
      }, 50);
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
  }, [searchTerm, leaderFilter, brandFilter, walletStatusFilter, walletTypeFilter, sortColumn, sortDirection]);

  useEffect(() => {
    if (!filterMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        filterButtonRef.current && !filterButtonRef.current.contains(target) &&
        filterDropdownRef.current && !filterDropdownRef.current.contains(target)
      ) {
        setFilterMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [filterMenuOpen]);

  useEffect(() => {
    if (!brandMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        brandButtonRef.current && !brandButtonRef.current.contains(target) &&
        brandDropdownRef.current && !brandDropdownRef.current.contains(target)
      ) {
        setBrandMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [brandMenuOpen]);

  useEffect(() => {
    if (!leaderMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        leaderButtonRef.current && !leaderButtonRef.current.contains(target) &&
        leaderDropdownRef.current && !leaderDropdownRef.current.contains(target)
      ) {
        setLeaderMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [leaderMenuOpen]);

  useEffect(() => {
    if (!walletTypeMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        walletTypeButtonRef.current && !walletTypeButtonRef.current.contains(target) &&
        walletTypeDropdownRef.current && !walletTypeDropdownRef.current.contains(target)
      ) {
        setWalletTypeMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [walletTypeMenuOpen]);

  useEffect(() => {
    if (!walletStatusMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        walletStatusButtonRef.current && !walletStatusButtonRef.current.contains(target) &&
        walletStatusDropdownRef.current && !walletStatusDropdownRef.current.contains(target)
      ) {
        setWalletStatusMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [walletStatusMenuOpen]);

  const visibleColumns = useMemo(() => columnDefs.filter((col) => columnVisibility[col.key]), [columnVisibility]);
  const allColumnsChecked = columnDefs.every((col) => columnVisibility[col.key]);
  const anyColumnHidden = columnDefs.some((col) => !columnVisibility[col.key]);
  const hiddenColumnCount = columnDefs.filter((col) => !columnVisibility[col.key]).length;

  const stickyLeft = useMemo(() => {
    const result: Partial<Record<ColumnKey, number>> = {};
    let offset = 0;
    for (const col of visibleColumns) {
      if (STICKY_COLS.includes(col.key)) {
        result[col.key] = offset;
        offset += parseInt(columnWidths[col.key], 10);
      }
    }
    return result;
  }, [visibleColumns]);

  const walletStatusOptions = useMemo(() => {
    const present = new Set(rows.map((row) => row.walletStatus));
    return WALLET_STATUS_OPTIONS.filter((status) => present.has(status));
  }, [rows]);

  const allWalletStatusesChecked = walletStatusOptions.every((status) => walletStatusFilter[status]);
  const anyWalletStatusUnchecked = walletStatusOptions.some((status) => !walletStatusFilter[status]);
  const selectedWalletStatusCount = walletStatusOptions.filter((status) => walletStatusFilter[status]).length;

  const leaderOptions = useMemo(() => {
    const leaders = Array.from(new Set(rows.map((row) => row.leader).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    return leaders;
  }, [rows]);

  const isLeaderChecked = (name: string) => leaderFilter[name] !== false;
  const allLeadersChecked = leaderOptions.every((name) => isLeaderChecked(name));
  const anyLeaderUnchecked = leaderOptions.some((name) => !isLeaderChecked(name));
  const selectedLeaderCount = leaderOptions.filter((name) => isLeaderChecked(name)).length;

  const brandOptions = useMemo(() => {
    const brands = Array.from(new Set(rows.map((row) => row.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    return brands;
  }, [rows]);

  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const allBrandsChecked = brandOptions.every((name) => isBrandChecked(name));
  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));
  const selectedBrandCount = brandOptions.filter((name) => isBrandChecked(name)).length;

  const walletTypeOptions = WALLET_TYPE_FILTER_LABELS;

  const isWalletTypeChecked = (name: string) => walletTypeFilter[name] !== false;
  const allWalletTypesChecked = walletTypeOptions.every((name) => isWalletTypeChecked(name));
  const anyWalletTypeUnchecked = walletTypeOptions.some((name) => !isWalletTypeChecked(name));
  const selectedWalletTypeCount = walletTypeOptions.filter((name) => isWalletTypeChecked(name)).length;

  const anyFilterActive = anyColumnHidden;

  const searchedRows = useMemo(() => {
    const query = searchTerm.toLowerCase();
    if (!query) return rows;

    return rows.filter((row) => {
      const haystack = `${row.leader} ${row.agentName} ${row.openingBal} ${row.sdp}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [rows, searchTerm]);

  const filteredRows = useMemo(() => {
    let list = searchedRows;
    if (leaderOptions.some((name) => leaderFilter[name] === false)) {
      list = list.filter((row) => leaderFilter[row.leader] !== false);
    }
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand] !== false);
    }
    if (walletStatusOptions.some((status) => !walletStatusFilter[status])) {
      list = list.filter((row) => walletStatusFilter[row.walletStatus]);
    }
    if (walletTypeOptions.some((name) => walletTypeFilter[name] === false)) {
      list = list.filter((row) => {
        if (row.walletType === '−') return isWalletTypeChecked('—');
        const rowAbbreviations = row.walletType.split(' | ');
        return WALLET_TYPE_FILTER_OPTIONS.some(
          (opt) => rowAbbreviations.includes(opt.abbreviation) && isWalletTypeChecked(opt.label)
        );
      });
    }
    return list;
  }, [leaderFilter, leaderOptions, brandFilter, brandOptions, walletStatusFilter, walletTypeFilter, walletTypeOptions, searchedRows]);

  const summaryCards = useMemo(() => {
    const totalDP = filteredRows.reduce((sum, row) => sum + row.agentTotalDP, 0);
    const totalWD = filteredRows.reduce((sum, row) => sum + row.agentTotalWD, 0);
    const totalSdp = filteredRows.reduce((sum, row) => sum + parseNumber(row.sdp), 0);
    const totalTopUp = filteredRows.reduce((sum, row) => sum + row.totalTopUp, 0);
    const totalSettlement = filteredRows.reduce((sum, row) => sum + row.totalStlm, 0);
    const totalBalanceInside = filteredRows.reduce((sum, row) => sum + row.balanceInside, 0);
    const totalRunningBalance = filteredRows.reduce((sum, row) => sum + row.runningBalance, 0);
    const totalOpening = filteredRows.reduce((sum, row) => sum + parseNumber(row.openingBal), 0);
    const runningVsOpening = totalRunningBalance - totalOpening;

    const cards: Array<{
      label: string;
      bigValue: string;
      subAmount: string;
      subSuffix?: string;
      subPositive: boolean;
      showArrow: boolean;
    }> = [
      {
        label: 'Total DP',
        bigValue: fmtAbbrev(totalDP),
        subAmount: fmt(totalDP),
        subPositive: false,
        showArrow: false,
      },
      {
        label: 'Total WD',
        bigValue: fmtAbbrev(totalWD),
        subAmount: fmt(totalWD),
        subPositive: false,
        showArrow: false,
      },
      {
        label: 'SDP',
        bigValue: fmtAbbrev(totalSdp),
        subAmount: fmt(totalSdp),
        subPositive: false,
        showArrow: false,
      },
      {
        label: 'Total Top Up',
        bigValue: fmtAbbrev(totalTopUp),
        subAmount: fmt(totalTopUp),
        subPositive: false,
        showArrow: false,
      },
      {
        label: 'Total Settlement',
        bigValue: fmtAbbrev(totalSettlement),
        subAmount: fmt(totalSettlement),
        subPositive: false,
        showArrow: false,
      },
      {
        label: 'Actual Balance',
        bigValue: fmtAbbrev(totalBalanceInside),
        subAmount: fmt(totalBalanceInside),
        subPositive: false,
        showArrow: false,
      },
      {
        label: 'Running Balance',
        bigValue: fmtAbbrev(totalRunningBalance),
        subAmount: fmt(runningVsOpening),
        subSuffix: 'vs opening',
        subPositive: runningVsOpening >= 0,
        showArrow: true,
      },
    ];

    return cards;
  }, [filteredRows]);

  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
    list.sort((a, b) => {
      const getValue = (row: typeof a, column: ColumnKey) => {
        switch (column) {
          case 'brand':
            return row.brand.toLowerCase();
          case 'leader':
            return row.leader.toLowerCase();
          case 'walletName':
            return row.agentName.toLowerCase();
          case 'walletType':
            return row.walletType.toLowerCase();
          case 'sdp':
            return parseNumber(row.sdp);
          case 'opening':
            return parseNumber(row.openingBal);
          case 'totalDP':
            return row.agentTotalDP;
          case 'totalWD':
            return row.agentTotalWD;
          case 'topUp':
            return row.totalTopUp;
          case 'settlement':
            return row.totalStlm;
          case 'balanceInside':
            return row.balanceInside;
          case 'agentWithdrawal':
            return row.agentWithdrawal;
          case 'sdpVsBalance':
            return row.sdpVsBalance;
          case 'walletStatus':
            return row.walletStatus.toLowerCase();
          case 'companyBalance':
          default:
            return row.runningBalance;
        }
      };

      const valueA = getValue(a, sortColumn);
      const valueB = getValue(b, sortColumn);

      if (sortColumn === 'walletName' || sortColumn === 'walletType' || sortColumn === 'leader' || sortColumn === 'walletStatus' || sortColumn === 'brand') {
        const comparison = String(valueA).localeCompare(String(valueB), undefined, { sensitivity: 'base' });
        return sortDirection === 'asc' ? comparison : -comparison;
      }

      const comparison = Number(valueA) - Number(valueB);
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return list;
  }, [filteredRows, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const pagedRows = sortedRows.slice(startIndex, endIndex);

  const handleExport = useCallback(() => {
    const getExportValue = (row: MergedRow, key: ColumnKey) => {
      switch (key) {
        case 'brand':
          return row.brand;
        case 'leader':
          return row.leader;
        case 'walletName':
          return row.agentName;
        case 'walletType':
          return row.walletType;
        case 'sdp':
          return numOrBlank(parseNumber(row.sdp));
        case 'opening':
          return numOrBlank(parseNumber(row.openingBal));
        case 'totalDP':
          return numOrBlank(row.agentTotalDP);
        case 'totalWD':
          return numOrBlank(row.agentTotalWD);
        case 'topUp':
          return numOrBlank(row.totalTopUp);
        case 'settlement':
          return numOrBlank(row.totalStlm);
        case 'companyBalance':
          return numOrBlank(row.runningBalance);
        case 'balanceInside':
          return numOrBlank(row.balanceInside);
        case 'agentWithdrawal':
          return numOrBlank(row.agentWithdrawal);
        case 'sdpVsBalance':
          return row.sdpVsBalance > 0 ? Math.abs(row.sdpVsBalance) : undefined;
        case 'walletStatus':
          return row.walletStatus;
      }
    };

    const headers = visibleColumns.map((col) => col.label);
    const data = sortedRows.map((row) => visibleColumns.map((col) => getExportValue(row, col.key)));

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Agent Balance');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SSP1_BALANCES_SUMMARY_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-white/95 py-0 pl-14 pr-4 backdrop-blur-sm dark:bg-[#0d1117]/95 md:px-8">
        <div className="flex h-12 items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-4 w-[3px] rounded-full bg-indigo-500" />
            {loading ? (
              <div className="h-4 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
            ) : (
              <h1 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">SSP Cashout</h1>
            )}
          </div>
          <div className="flex items-center gap-2">
            {loading ? (
              <>
                <div className="hidden h-6 w-24 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700 sm:block" />
                <div className="h-7 w-16 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />
                <div className="h-6 w-6 animate-pulse rounded-full bg-slate-200 dark:bg-slate-700" />
              </>
            ) : (
              <>
                <ThemeToggle />
                <button
                  onClick={fetchData}
                  disabled={spinning || loading}
                  aria-label="Refresh"
                  title="Refresh"
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <RefreshCw size={11} className={spinning ? 'animate-spin' : ''} />
                </button>
                <button
                  type="button"
                  onClick={() => setCardsExpanded((current) => !current)}
                  title={cardsExpanded ? 'Hide summary cards' : 'Show summary cards'}
                  className="flex items-center justify-center rounded-lg border border-border bg-muted/60 p-1.5 text-muted-foreground transition-colors hover:bg-muted"
                >
                  {cardsExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden px-6 pt-4 pb-6">
        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <div className={`shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${cardsExpanded ? 'h-[102px] opacity-100 mb-1' : 'h-0 opacity-0 mb-0'}`}>
            <div className="flex gap-2 overflow-x-auto pb-3">
              {loading ? (
                Array.from({ length: 7 }).map((_, i) => (
                  <div key={i} className="rounded-xl border border-border bg-white dark:bg-[#2a2a2d] shadow-sm flex-1 min-w-[100px] p-2.5">
                    <div className="h-3 w-12 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="mt-1.5 h-6 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    <div className="mt-1 h-5 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  </div>
                ))
              ) : (
                summaryCards.map((card) => (
                  <div key={card.label} className="rounded-xl border border-border bg-white dark:bg-[#2a2a2d] shadow-sm flex-1 min-w-[100px] p-2.5 hover:shadow-md">
                    <p className="text-[10px] font-semibold text-muted-foreground truncate">{card.label}</p>
                    <p className="mt-1 text-[15px] font-bold leading-tight text-foreground">{card.bigValue}</p>
                    <div className={`mt-0.5 text-[9px] font-medium ${
                      card.label === 'Total DP' ? 'text-emerald-600 dark:text-emerald-400' :
                      card.label === 'Total WD' ? 'text-rose-600 dark:text-rose-400' :
                      card.label === 'Running Balance' ? (card.subPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400') :
                      'text-muted-foreground'
                    }`}>
                      <div className="flex items-center gap-0.5">
                        {card.showArrow && <span>{card.subPositive ? '▲' : '▼'}</span>}
                        <span className="tabular-nums">{card.subAmount}</span>
                      </div>
                      {card.subSuffix && <span className="block font-normal text-muted-foreground">{card.subSuffix}</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {!error && (
          <div className="flex-1 flex flex-col min-h-0 mt-3 bg-white rounded-xl border border-border overflow-hidden dark:bg-[#2a2a2d]">
            <div className="shrink-0 px-3 py-2 border-b border-border bg-muted/20 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {loading ? (
                  <div className="h-5 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                ) : (
                  <div className="flex items-center gap-1.5 rounded-md bg-indigo-50 px-2.5 py-1 dark:bg-indigo-500/15">
                    <span className="text-[10px] font-medium text-indigo-600 dark:text-indigo-400">Accounts</span>
                    <span className="text-[11px] font-bold tabular-nums text-indigo-700 dark:text-indigo-300">{sortedRows.length.toLocaleString('en-PH')}</span>
                  </div>
                )}
                <div className="flex w-full min-w-[140px] flex-1 items-center gap-2 rounded-lg border border-border bg-white px-3 py-1.5 dark:bg-[#2a2a2d] sm:w-52 sm:flex-none">
                  {loading ? (
                    <div className="h-3 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  ) : (
                    <>
                      <Search size={13} className="shrink-0 text-muted-foreground" />
                      <input
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        className="flex-1 bg-transparent text-[10px] text-foreground placeholder:text-muted-foreground outline-none border-none"
                        placeholder="Search shops or brands..."
                      />
                    </>
                  )}
                </div>
                <div className="relative">
                  {!loading && (
                    <button
                      type="button"
                      ref={filterButtonRef}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = filterButtonRef.current?.getBoundingClientRect();
                        if (rect) {
                          const dropdownWidth = 224;
                          const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                          setFilterMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                        }
                        setFilterMenuOpen((current) => !current);
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium border rounded-lg hover:bg-white transition-colors ${anyFilterActive ? 'border-indigo-200 text-indigo-700 dark:border-indigo-900/50 dark:text-indigo-300' : 'border-border text-foreground'}`}
                    >
                      <Filter size={14} />
                      Filter
                      {anyColumnHidden && (
                        <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-indigo-600 px-1 text-[9px] font-semibold leading-none text-white">
                          {hiddenColumnCount}
                        </span>
                      )}
                    </button>
                  )}
                {filterMenuOpen && typeof document !== 'undefined' && createPortal(
                  <div
                    ref={filterDropdownRef}
                    style={{ position: 'fixed', top: filterMenuPos.top, left: filterMenuPos.left }}
                    className="z-[9999] w-56 max-h-[70vh] overflow-y-auto rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Columns</div>
                    <label className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                      <input
                        type="checkbox"
                        checked={allColumnsChecked}
                        onChange={() => {
                          const nextValue = !allColumnsChecked;
                          setColumnVisibility(
                            Object.fromEntries(columnDefs.map((col) => [col.key, nextValue])) as Record<ColumnKey, boolean>
                          );
                        }}
                      />
                      <span>Check All</span>
                    </label>
                    {columnDefs.map((col) => (
                      <label key={col.key} className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                        <input
                          type="checkbox"
                          checked={columnVisibility[col.key]}
                          onChange={() => {
                            setColumnVisibility((current) => ({ ...current, [col.key]: !current[col.key] }));
                          }}
                        />
                        <span>{col.label}</span>
                      </label>
                    ))}
                  </div>,
                  document.body
                )}
              </div>
              </div>
              <div className="flex items-center gap-2">
                {loading ? (
                  <div className="h-6 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {currentPage} / {totalPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                      disabled={currentPage === 1}
                      className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-[10px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40 dark:bg-transparent"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                      disabled={currentPage === totalPages}
                      className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-[10px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40 dark:bg-transparent"
                    >
                      Next
                    </button>
                  </div>
                )}
                {loading && <div className="h-7 w-20 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />}
                {!loading && (
                  <button
                    type="button"
                    onClick={handleExport}
                    title="Export to Excel"
                    className="rounded-lg border border-border bg-white p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:bg-transparent"
                  >
                    <Download size={13} />
                  </button>
                )}
              </div>
            </div>
            <div className="hidden flex-1 min-h-0 overflow-y-auto overflow-x-auto sm:block">
              <table className="w-full table-fixed text-xs" style={{ minWidth: TABLE_MIN_WIDTH }}>
                <colgroup>
                  {visibleColumns.map((col) => (
                    <col key={col.key} style={{ width: columnWidths[col.key] }} />
                  ))}
                </colgroup>
                <thead className="sticky top-0 z-[50] bg-white dark:bg-[#252528] border-b border-border shadow-[0_1px_3px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]">
                  <tr>
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        style={stickyLeft[col.key] !== undefined ? { position: 'sticky' as const, left: `${stickyLeft[col.key]}px`, zIndex: 52 } : undefined}
                        className={headerCellClasses(col.key, sortColumn === col.key)}>
                        {loading ? (
                          <div className="mx-auto h-[18px] w-14 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        ) : col.key === 'brand' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <span className="normal-case font-semibold text-foreground">{col.label}</span>
                            <button
                              type="button"
                              ref={brandButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                const rect = brandButtonRef.current?.getBoundingClientRect();
                                if (rect) {
                                  const dropdownWidth = 176;
                                  const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                                  setBrandMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                                }
                                setBrandMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyBrandUnchecked ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/30 dark:text-indigo-200' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              {anyBrandUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedBrandCount}
                                </span>
                              ) : (
                                <ChevronUp
                                  size={12}
                                  className={`transition-transform duration-150 ease-in-out ${brandMenuOpen ? 'rotate-180' : ''} opacity-70`}
                                />
                              )}
                            </button>
                            {brandMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={brandDropdownRef}
                                style={{ position: 'fixed', top: brandMenuPos.top, left: brandMenuPos.left }}
                                className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Brand</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-start gap-2 rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allBrandsChecked}
                                      onChange={() => {
                                        const nextValue = !allBrandsChecked;
                                        setBrandFilter(
                                          Object.fromEntries(brandOptions.map((name) => [name, nextValue]))
                                        );
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {brandOptions.map((brand) => (
                                    <label key={brand} className="flex w-full items-center justify-start gap-2 rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={isBrandChecked(brand)}
                                        onChange={() => {
                                          setBrandFilter((current) => ({ ...current, [brand]: !isBrandChecked(brand) }));
                                        }}
                                      />
                                      <span>{brand}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>,
                              document.body
                            )}
                          </div>
                        ) : col.key === 'leader' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <span className="normal-case font-semibold text-foreground">{col.label}</span>
                            <button
                              type="button"
                              ref={leaderButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                const rect = leaderButtonRef.current?.getBoundingClientRect();
                                if (rect) {
                                  const dropdownWidth = 176;
                                  const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                                  setLeaderMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                                }
                                setLeaderMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyLeaderUnchecked ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/30 dark:text-indigo-200' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              {anyLeaderUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedLeaderCount}
                                </span>
                              ) : (
                                <ChevronUp
                                  size={12}
                                  className={`transition-transform duration-150 ease-in-out ${leaderMenuOpen ? 'rotate-180' : ''} opacity-70`}
                                />
                              )}
                            </button>
                            {leaderMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={leaderDropdownRef}
                                style={{ position: 'fixed', top: leaderMenuPos.top, left: leaderMenuPos.left }}
                                className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Leader</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-start gap-2 rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allLeadersChecked}
                                      onChange={() => {
                                        const nextValue = !allLeadersChecked;
                                        setLeaderFilter(
                                          Object.fromEntries(leaderOptions.map((name) => [name, nextValue]))
                                        );
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {leaderOptions.map((leader) => (
                                    <label key={leader} className="flex w-full items-center justify-start gap-2 rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={isLeaderChecked(leader)}
                                        onChange={() => {
                                          setLeaderFilter((current) => ({ ...current, [leader]: !isLeaderChecked(leader) }));
                                        }}
                                      />
                                      <span>{leader}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>,
                              document.body
                            )}
                          </div>
                        ) : col.key === 'walletType' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <span className="normal-case font-semibold text-foreground">{col.label}</span>
                            <button
                              type="button"
                              ref={walletTypeButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                const rect = walletTypeButtonRef.current?.getBoundingClientRect();
                                if (rect) {
                                  const dropdownWidth = 176;
                                  const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                                  setWalletTypeMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                                }
                                setWalletTypeMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyWalletTypeUnchecked ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/30 dark:text-indigo-200' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              {anyWalletTypeUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedWalletTypeCount}
                                </span>
                              ) : (
                                <ChevronUp
                                  size={12}
                                  className={`transition-transform duration-150 ease-in-out ${walletTypeMenuOpen ? 'rotate-180' : ''} opacity-70`}
                                />
                              )}
                            </button>
                            {walletTypeMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={walletTypeDropdownRef}
                                style={{ position: 'fixed', top: walletTypeMenuPos.top, left: walletTypeMenuPos.left }}
                                className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Wallet Type</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allWalletTypesChecked}
                                      onChange={() => {
                                        const nextValue = !allWalletTypesChecked;
                                        setWalletTypeFilter(Object.fromEntries(walletTypeOptions.map((name) => [name, nextValue])));
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {walletTypeOptions.map((type) => (
                                    <label key={type} className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={isWalletTypeChecked(type)}
                                        onChange={() => {
                                          setWalletTypeFilter((current) => ({ ...current, [type]: !isWalletTypeChecked(type) }));
                                        }}
                                      />
                                      <span>{type}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>,
                              document.body
                            )}
                          </div>
                        ) : col.key === 'walletStatus' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <span className="normal-case font-semibold text-foreground">{col.label}</span>
                            <button
                              type="button"
                              ref={walletStatusButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                const rect = walletStatusButtonRef.current?.getBoundingClientRect();
                                if (rect) {
                                  const dropdownWidth = 176;
                                  const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                                  setWalletStatusMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                                }
                                setWalletStatusMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyWalletStatusUnchecked ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/30 dark:text-indigo-200' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              {anyWalletStatusUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedWalletStatusCount}
                                </span>
                              ) : (
                                <ChevronUp
                                  size={12}
                                  className={`transition-transform duration-150 ease-in-out ${walletStatusMenuOpen ? 'rotate-180' : ''} opacity-70`}
                                />
                              )}
                            </button>
                            {walletStatusMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={walletStatusDropdownRef}
                                style={{ position: 'fixed', top: walletStatusMenuPos.top, left: walletStatusMenuPos.left }}
                                className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Wallet Status</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allWalletStatusesChecked}
                                      onChange={() => {
                                        const nextValue = !allWalletStatusesChecked;
                                        setWalletStatusFilter(Object.fromEntries(walletStatusOptions.map((status) => [status, nextValue])));
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {walletStatusOptions.map((status) => (
                                    <label key={status} className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={!!walletStatusFilter[status]}
                                        onChange={() => {
                                          setWalletStatusFilter((current) => ({ ...current, [status]: !current[status] }));
                                        }}
                                      />
                                      <span>{status}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>,
                              document.body
                            )}
                          </div>
                        ) : col.sortable ? (
                          <button
                            type="button"
                            onClick={() => {
                              if (sortColumn === col.key) {
                                setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
                              } else {
                                setSortColumn(col.key);
                                setSortDirection('asc');
                              }
                            }}
                            className="flex w-full items-center justify-center gap-1 transition hover:opacity-80"
                          >
                            <span>{col.label}</span>
                            <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                          </button>
                        ) : (
                          col.label
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? Array.from({ length: 18 }).map((_, i) => (
                    <tr key={i}>
                      {visibleColumns.map((col) => (
                        <td key={col.key} className="px-3 py-1.5">
                          <div className="mx-auto h-2.5 w-3/4 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </td>
                      ))}
                    </tr>
                  )) : pagedRows.length > 0 ? pagedRows.map((row, i) => (
                    <tr
                      key={row.agentName || i}
                      className="hover:bg-muted/10 transition-colors"
                    >
                      {visibleColumns.map((col) => renderCell(row, col.key))}
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={Math.max(visibleColumns.length, 1)} className="px-3 py-8 text-center text-[9px] text-muted-foreground">
                        No matching accounts found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

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
                  pagedRows.map((row, i) => {
                    const showName = columnVisibility.walletName;
                    const showBrand = columnVisibility.brand;
                    const showStatus = columnVisibility.walletStatus;
                    const showBalance = columnVisibility.companyBalance;
                    const subtitle = [
                      columnVisibility.leader ? row.leader : null,
                      columnVisibility.walletType && row.walletType !== '−' ? row.walletType : null,
                    ].filter(Boolean).join(' · ');
                    const hasHeader = showName || showBrand || showStatus || !!subtitle;

                    const gridFields = BALANCE_GRID_ORDER.filter((key) => columnVisibility[key]);

                    return (
                      <div key={row.agentName || i} className="rounded-xl border-[0.5px] border-border bg-white p-4 dark:bg-[#2a2a2d]">
                        {hasHeader && (
                          <div className="flex items-start justify-between gap-2 border-b border-border pb-3">
                            <div className="min-w-0">
                              {showName && <p className="truncate text-base font-bold text-foreground">{row.agentName}</p>}
                              {subtitle && <p className="truncate text-[12px] text-muted-foreground">{subtitle}</p>}
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {showBrand && (
                                <span className="rounded-full border-[0.5px] border-border px-2.5 py-0.5 text-[11px] text-muted-foreground">
                                  {row.brand}
                                </span>
                              )}
                              {showStatus && (
                                <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${walletStatusBadgeClasses(row.walletStatus)}`}>
                                  {row.walletStatus}
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        {showBalance && (
                          <div className={`flex items-center justify-between ${hasHeader ? 'pt-3' : ''}`}>
                            <span className="text-[12px] text-muted-foreground">Company Balance</span>
                            <span className="text-xl font-bold tabular-nums text-foreground">{displayNum(row.runningBalance)}</span>
                          </div>
                        )}

                        {gridFields.length > 0 && (
                          <div className={`grid grid-cols-3 gap-x-3 gap-y-3 ${(hasHeader || showBalance) ? 'mt-3' : ''}`}>
                            {gridFields.map((key) => {
                              const col = columnDefs.find((c) => c.key === key)!;
                              const { value, className } = mobileCardFieldValue(row, key);
                              return (
                                <div key={key}>
                                  <p className="text-[11px] text-muted-foreground">{col.label}</p>
                                  <p className={`mt-0.5 text-[13px] font-semibold tabular-nums ${className}`}>{value}</p>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="px-3 py-8 text-center text-[11px] text-muted-foreground">
                    No matching accounts found.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}