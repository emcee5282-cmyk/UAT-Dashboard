'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Download, Filter, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import ThemeToggle from '@/app/components/ThemeToggle';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '@/app/lib/errors';
import { rawVal } from '@/app/lib/format';
import { BRAND_CODES as CASHOUT_BRAND_CODES } from '@/app/lib/transferQueueCount';

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

function displayNum(num: number): string {
  if (Math.abs(num) < 0.01) return '−';
  const formatted = Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `-${formatted}` : formatted;
}

function parseNumber(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// Opening sheet col I holds Send Money's own "UPDATED TIME" card (same cutoff
// mechanism used on /sendmoney/balances) — Settlement rows dated before this
// reset point are excluded so they aren't double-counted into Company Balance.
function parseReportCutoffDate(openingRawRows: string[][]): Date | null {
  for (const row of openingRawRows) {
    const cell = (row[8] ?? '').trim();
    const match = cell.match(/^([A-Za-z]+)\s+(\d{1,2})\s*-\s*\d{1,2}:\d{2}\s*[AP]M$/i);
    if (match) {
      const [, monthName, day] = match;
      const year = new Date().getFullYear();
      const parsed = new Date(`${monthName} ${day}, ${year}`);
      if (!isNaN(parsed.getTime())) {
        parsed.setHours(0, 0, 0, 0);
        return parsed;
      }
    }
  }
  return null;
}

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

const EXCLUDED_WALLET_STATUSES = ['Wallet With Issue', 'Disconnected', 'No Record'];

// No Send Money leaders are excluded from SDP VS Balance — Cashout's
// exclusion list doesn't carry over (different leader roster).
const EXCLUDED_SDP_LEADERS: string[] = [];

// Raw gap between Company Balance and SDP, with no display floor — unlike the
// Agent Balance page's own SDP VS Balance column (which only shows values
// over 30,000), the Transfer Queue's own trigger threshold is 8,000, so the
// value can't be pre-floored to 30,000 or the 8,000 gate would never see
// anything between 8,001 and 29,999.
function computeSdpVsBalanceRaw(leader: string, sdpRaw: string, sdpNum: number, companyBalance: number): number {
  const normalizedLeader = leader.trim().toUpperCase();
  if (EXCLUDED_SDP_LEADERS.includes(normalizedLeader)) return 0;

  const sdpTrimmed = sdpRaw.trim().toUpperCase();
  return sdpTrimmed === 'NO SDP' || sdpNum === 0 ? companyBalance : companyBalance - sdpNum;
}

const BRAND_PRIORITY = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1', 'SH'];
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

const BRAND_CODES = [...CASHOUT_BRAND_CODES, 'SH'];
const BRAND_DISPLAY_LABELS: Record<string, string> = { SH: 'Sharing' };

function displayBrand(code: string): string {
  return BRAND_DISPLAY_LABELS[code] ?? code;
}

function resolveBrand(groups: string[], agentName: string): string {
  const brand = computeBrand(groups);
  if (brand !== '−' && BRAND_CODES.includes(brand)) return brand;
  return BRAND_CODES.find((code) => agentName.toUpperCase().includes(code)) ?? '−';
}

function normalizeGroup(s: string): string {
  return s.toUpperCase().replace(/[\s-]+/g, '');
}

// Send Money's own Transfer Queue ruleset (confirmed with user): unlike
// Cashout, there's no DAY variant and no separate "Low Balance"/"Discrepancy"
// group names — every brand below has exactly two possible correct groups,
// "{Brand} 24/7 DP + WD" and "{Brand} 24/7 WD Only". SDP VS Balance > 50,000,
// Discrepancy > 10,000, and Company Balance > 45,000 are independent triggers
// that all point to WD Only (checked first); Company Balance < 20,000 is the
// only trigger for DP + WD. 'SH' (Sharing) has no rule and is never queued.
const QUEUE_BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];

function resolveCorrectGroup(brand: string, companyBalance: number, sdpVsBalance: number, discrepancy: number): { groupName: string; remarks: string } | null {
  if (!QUEUE_BRAND_CODES.includes(brand)) return null;

  if (sdpVsBalance > 50000) return { groupName: `${brand} 24/7 WD Only`, remarks: 'SDP VS Balance exceeded 50,000' };
  if (discrepancy > 10000) return { groupName: `${brand} 24/7 WD Only`, remarks: 'Discrepancy is higher than 10,000' };
  if (companyBalance > 45000) return { groupName: `${brand} 24/7 WD Only`, remarks: 'Company balance exceeded 45,000' };
  if (companyBalance < 20000) return { groupName: `${brand} 24/7 DP + WD`, remarks: 'Company balance is below 20,000' };

  return null;
}

type QueueRow = {
  key: string;
  shopName: string;
  account: string;
  brand: string;
  currentGroup: string;
  correctGroup: string;
  companyBalance: number;
  discrepancy: number;
  sdpVsBalance: number;
  balanceInside: number;
  remarks: string;
};

type ColumnKey = 'brand' | 'shopName' | 'companyBalance' | 'balanceInside' | 'discrepancy' | 'sdpVsBalance' | 'currentGroup' | 'correctGroup' | 'remarks';

const columnDefs: { key: ColumnKey; label: string }[] = [
  { key: 'brand', label: 'Brand' },
  { key: 'shopName', label: 'Agent' },
  { key: 'companyBalance', label: 'Company Balance' },
  { key: 'balanceInside', label: 'Balance Inside' },
  { key: 'discrepancy', label: 'Discrepancy' },
  { key: 'sdpVsBalance', label: 'SDP VS Balance' },
  { key: 'currentGroup', label: 'Current Group' },
  { key: 'correctGroup', label: 'Correct Group' },
  { key: 'remarks', label: 'Remarks' },
];

const columnWidths: Record<ColumnKey, string> = {
  brand: '7%',
  shopName: '11%',
  companyBalance: '10%',
  balanceInside: '11%',
  discrepancy: '9%',
  sdpVsBalance: '9%',
  currentGroup: '14%',
  correctGroup: '14%',
  remarks: '15%',
};

const rowSkeletonWidths: Record<ColumnKey, string[]> = {
  brand: ['w-8', 'w-10', 'w-9'],
  shopName: ['w-20', 'w-24', 'w-16'],
  companyBalance: ['w-14', 'w-16', 'w-12'],
  balanceInside: ['w-14', 'w-16', 'w-12'],
  discrepancy: ['w-12', 'w-14', 'w-10'],
  sdpVsBalance: ['w-14', 'w-16', 'w-12'],
  currentGroup: ['w-24', 'w-28', 'w-20'],
  correctGroup: ['w-24', 'w-28', 'w-20'],
  remarks: ['w-28', 'w-32', 'w-24'],
};

function headerCellClasses(_colKey: ColumnKey, _active: boolean) {
  return `group text-center px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] whitespace-nowrap text-muted-foreground`;
}

function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  if (!active) {
    return (
      <span className="flex flex-col items-center justify-center leading-none text-slate-400 opacity-0 transition-opacity duration-150 group-hover:opacity-40">
        <ChevronUp size={10} className="-mb-0.5" />
        <ChevronDown size={10} />
      </span>
    );
  }
  return direction === 'asc' ? (
    <ChevronUp size={10} className="text-[color:var(--product-accent)]" />
  ) : (
    <ChevronDown size={10} className="text-[color:var(--product-accent)]" />
  );
}

function mobileNumericField(row: QueueRow, key: ColumnKey): { value: string; className: string } {
  switch (key) {
    case 'balanceInside':
      return { value: displayNum(row.balanceInside), className: row.balanceInside < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground' };
    case 'discrepancy':
      return { value: displayNum(row.discrepancy), className: 'text-foreground' };
    case 'sdpVsBalance':
      return { value: row.sdpVsBalance > 0 ? displayNum(Math.abs(row.sdpVsBalance)) : '−', className: 'text-foreground' };
    default:
      return { value: '−', className: 'text-foreground' };
  }
}

function renderCell(row: QueueRow, key: ColumnKey) {
  const base = 'whitespace-nowrap overflow-hidden text-ellipsis text-[11px] text-center px-3 py-1.5';
  switch (key) {
    case 'brand':
      return <td key={key} className={`${base} text-muted-foreground`}>{displayBrand(row.brand)}</td>;
    case 'shopName':
      return <td key={key} className={`${base} font-semibold text-foreground`}>{row.account}</td>;
    case 'companyBalance':
      return (
        <td key={key} className={`${base} tabular-nums font-bold ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
          {displayNum(row.companyBalance)}
        </td>
      );
    case 'balanceInside':
      return (
        <td key={key} className={`${base} tabular-nums ${row.balanceInside < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
          {displayNum(row.balanceInside)}
        </td>
      );
    case 'discrepancy':
      return (
        <td key={key} className={`${base} tabular-nums text-foreground`}>
          {displayNum(row.discrepancy)}
        </td>
      );
    case 'sdpVsBalance':
      return (
        <td key={key} className={`${base} tabular-nums text-foreground`}>
          {row.sdpVsBalance > 0 ? displayNum(Math.abs(row.sdpVsBalance)) : '−'}
        </td>
      );
    case 'currentGroup':
      return <td key={key} className={`${base} text-muted-foreground`}>{row.currentGroup}</td>;
    case 'correctGroup':
      return <td key={key} className={`${base} font-medium text-foreground`}>{row.correctGroup}</td>;
    case 'remarks':
      return <td key={key} className={`${base} text-muted-foreground`}>{row.remarks}</td>;
  }
}

export default function SendMoneyTransferQueue() {
  const [queueRows, setQueueRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<ColumnKey>('companyBalance');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [correctGroupFilter, setCorrectGroupFilter] = useState<Record<string, boolean>>({});
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [brandMenuPos, setBrandMenuPos] = useState({ top: 0, left: 0 });
  const [correctGroupMenuOpen, setCorrectGroupMenuOpen] = useState(false);
  const [correctGroupMenuPos, setCorrectGroupMenuPos] = useState({ top: 0, left: 0 });
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [columnMenuPos, setColumnMenuPos] = useState({ top: 0, left: 0 });
  const [columnVisibility, setColumnVisibility] = useState<Record<ColumnKey, boolean>>(
    () => Object.fromEntries(columnDefs.map((col) => [col.key, true])) as Record<ColumnKey, boolean>
  );
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandDropdownRef = useRef<HTMLDivElement>(null);
  const correctGroupButtonRef = useRef<HTMLButtonElement>(null);
  const correctGroupDropdownRef = useRef<HTMLDivElement>(null);
  const columnButtonRef = useRef<HTMLButtonElement>(null);
  const columnDropdownRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const rowsPerPage = 50;

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);

      // Reuses Cashout's own /api/opening as-is for the roster, plus two
      // Send Money-specific routes: /api/sendmoney/balances ("SSP PS
      // BalanceLimit") and /api/sendmoney/stlmtopup ("PS BD STLM + TOPUP",
      // Send Money's own dedicated Settlement + Top Up sheet) — same three
      // sources as /sendmoney/balances.
      const [openingRes, balRes, stlmRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/sendmoney/balances?t=${Date.now()}`),
        fetch(`/api/sendmoney/stlmtopup?t=${Date.now()}`),
      ]);

      await assertAllOk([openingRes, balRes, stlmRes]);

      const openingText = await openingRes.text();
      const balData: string[][] = await balRes.json();
      const stlmText = await stlmRes.text();

      const openingRawRows = parseCsvLines(openingText);
      const reportCutoffDate = parseReportCutoffDate(openingRawRows);

      // Send Money's own roster lives in cols L-O (indices 11-14) of "Opening AG".
      const openingRows = openingRawRows
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: rawVal(row[11]),
          openingBal: rawVal(row[12]),
          sdp: rawVal(row[13]),
          leader: rawVal(row[14]),
        }))
        .filter((row) => row.agentName && row.agentName !== '-' && row.agentName !== 'OLD');

      // "SSP PS BalanceLimit" lines up with Cashout's own Balance Limit sheet
      // from index 4 onward, just without Cashout's leading "Reference" column.
      const balRows = balData
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          walletName: rawVal(row[0]),
          totalDP: rawVal(row[11]),
          totalWD: rawVal(row[13]),
          balance: rawVal(row[8]),
          login: rawVal(row[15]),
          accountStatus: rawVal(row[1]),
          group: rawVal(row[6]),
        }))
        .filter((row) => row.walletName && row.walletName !== '-');

      const balWalletNames = new Set(balRows.map((bal) => bal.walletName));
      const balanceTotals = new Map<string, { dp: number; wd: number }>();
      const balanceInsideTotals = new Map<string, number>();
      const walletStatusValues = new Map<string, string[]>();
      const brandGroups = new Map<string, string[]>();
      balRows.forEach((bal) => {
        const name = bal.walletName;
        const dp = parseFloat(bal.totalDP.replace(/,/g, '')) || 0;
        const wd = parseFloat(bal.totalWD.replace(/,/g, '')) || 0;
        const existing = balanceTotals.get(name) ?? { dp: 0, wd: 0 };
        balanceTotals.set(name, { dp: existing.dp + dp, wd: existing.wd + wd });

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

        if (bal.login.trim().toLowerCase() === 'yes') {
          const balance = parseFloat(bal.balance.replace(/,/g, '')) || 0;
          balanceInsideTotals.set(name, (balanceInsideTotals.get(name) ?? 0) + balance);
        }
      });

      // "PS BD STLM + TOPUP" is Send Money's own dedicated sheet (replaces
      // the old shared "Stlm Top Up" cols A-G source). Top Up lives in cols
      // B-F (indices 1-5), amounts stored positive; Settlement lives in cols
      // H-L (indices 7-11), amounts stored negative (money leaving) so
      // they're abs()'d — same cutoff-date filtering as /sendmoney/balances
      // so rows already folded into the last Opening Balance reset aren't
      // double-counted.
      const topUpTotals = new Map<string, number>();
      const stlmTotals = new Map<string, number>();
      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const topUpAgent = rawVal(row[1]);
          const topUpAmount = rawVal(row[2]);
          const topUpDate = reportCutoffDate ? parseSheetDate(rawVal(row[3])) : null;
          if (
            topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-' &&
            (!reportCutoffDate || (topUpDate && topUpDate >= reportCutoffDate))
          ) {
            const amount = Math.abs(parseFloat(topUpAmount.replace(/,/g, '')) || 0);
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
          }

          const stlmAgent = rawVal(row[7]);
          const stlmAmount = rawVal(row[8]);
          const stlmDate = reportCutoffDate ? parseSheetDate(rawVal(row[9])) : null;
          if (
            stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-' &&
            (!reportCutoffDate || (stlmDate && stlmDate >= reportCutoffDate))
          ) {
            const amount = Math.abs(parseFloat(stlmAmount.replace(/,/g, '')) || 0);
            stlmTotals.set(stlmAgent, (stlmTotals.get(stlmAgent) ?? 0) + amount);
          }
        });

      const agentInfo = new Map<string, { companyBalance: number; sdpVsBalance: number; discrepancy: number; balanceInside: number; walletStatus: string; brand: string }>();
      openingRows.forEach((opening) => {
        const totals = balanceTotals.get(opening.agentName) ?? { dp: 0, wd: 0 };
        const totalTopUp = topUpTotals.get(opening.agentName) ?? 0;
        const totalStlm = stlmTotals.get(opening.agentName) ?? 0;
        const balanceInside = balanceInsideTotals.get(opening.agentName) ?? 0;
        const companyBalance = parseNumber(opening.openingBal) + totals.dp + totalTopUp - totals.wd - totalStlm;
        const sdpNum = parseNumber(opening.sdp);
        const walletStatus = balWalletNames.has(opening.agentName)
          ? computeWalletStatus(walletStatusValues.get(opening.agentName) ?? [])
          : 'No Record';

        agentInfo.set(opening.agentName, {
          companyBalance,
          sdpVsBalance: computeSdpVsBalanceRaw(opening.leader, opening.sdp, sdpNum, companyBalance),
          discrepancy: companyBalance - balanceInside,
          balanceInside,
          walletStatus,
          brand: resolveBrand(brandGroups.get(opening.agentName) ?? [], opening.agentName),
        });
      });

      const queue: QueueRow[] = [];
      balRows.forEach((bal, index) => {
        const info = agentInfo.get(bal.walletName);
        if (!info) return;
        if (EXCLUDED_WALLET_STATUSES.includes(info.walletStatus)) return;

        const currentGroup = bal.group.trim();
        if (currentGroup.toLowerCase().includes('top up')) return;
        // Shops whose wallet name carries a "BD" segment (e.g. "D-M2BD-DELTA063-NG")
        // are excluded from the Transfer Queue entirely, per user instruction.
        if (bal.walletName.toUpperCase().includes('BD')) return;
        const resolved = resolveCorrectGroup(info.brand, info.companyBalance, info.sdpVsBalance, info.discrepancy);
        if (!resolved) return;
        if (normalizeGroup(currentGroup) === normalizeGroup(resolved.groupName)) return;

        queue.push({
          key: `${bal.walletName}-${index}`,
          shopName: bal.walletName,
          account: bal.walletName,
          brand: info.brand,
          currentGroup,
          correctGroup: resolved.groupName,
          companyBalance: info.companyBalance,
          discrepancy: info.discrepancy,
          sdpVsBalance: info.sdpVsBalance,
          balanceInside: info.balanceInside,
          remarks: resolved.remarks,
        });
      });

      setQueueRows(queue);
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
  }, [searchTerm, brandFilter, correctGroupFilter, sortColumn, sortDirection]);

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
    if (!correctGroupMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        correctGroupButtonRef.current && !correctGroupButtonRef.current.contains(target) &&
        correctGroupDropdownRef.current && !correctGroupDropdownRef.current.contains(target)
      ) {
        setCorrectGroupMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [correctGroupMenuOpen]);

  useEffect(() => {
    if (!columnMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        columnButtonRef.current && !columnButtonRef.current.contains(target) &&
        columnDropdownRef.current && !columnDropdownRef.current.contains(target)
      ) {
        setColumnMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [columnMenuOpen]);

  const searchedRows = useMemo(() => {
    const query = searchTerm.toLowerCase();
    if (!query) return queueRows;
    return queueRows.filter((row) =>
      `${row.shopName} ${row.currentGroup} ${row.correctGroup}`.toLowerCase().includes(query)
    );
  }, [queueRows, searchTerm]);

  const brandOptions = useMemo(() => {
    const rows = searchedRows.filter((row) => correctGroupFilter[row.correctGroup] !== false);
    return Array.from(new Set(rows.map((row) => row.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [searchedRows, correctGroupFilter]);
  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const allBrandsChecked = brandOptions.every((name) => isBrandChecked(name));
  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));
  const selectedBrandCount = brandOptions.filter((name) => isBrandChecked(name)).length;

  const correctGroupOptions = useMemo(() => {
    const rows = searchedRows.filter((row) => brandFilter[row.brand] !== false);
    return Array.from(new Set(rows.map((row) => row.correctGroup).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [searchedRows, brandFilter]);
  const isCorrectGroupChecked = (name: string) => correctGroupFilter[name] !== false;
  const allCorrectGroupsChecked = correctGroupOptions.every((name) => isCorrectGroupChecked(name));
  const anyCorrectGroupUnchecked = correctGroupOptions.some((name) => !isCorrectGroupChecked(name));
  const selectedCorrectGroupCount = correctGroupOptions.filter((name) => isCorrectGroupChecked(name)).length;

  const filteredRows = useMemo(() => {
    let list = searchedRows;
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand] !== false);
    }
    if (correctGroupOptions.some((name) => correctGroupFilter[name] === false)) {
      list = list.filter((row) => correctGroupFilter[row.correctGroup] !== false);
    }
    return list;
  }, [searchedRows, brandFilter, brandOptions, correctGroupFilter, correctGroupOptions]);

  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
    list.sort((a, b) => {
      const getValue = (row: QueueRow, column: ColumnKey) => {
        switch (column) {
          case 'brand':
            return displayBrand(row.brand).toLowerCase();
          case 'shopName':
            return row.account.toLowerCase();
          case 'companyBalance':
            return row.companyBalance;
          case 'balanceInside':
            return row.balanceInside;
          case 'discrepancy':
            return row.discrepancy;
          case 'sdpVsBalance':
            return row.sdpVsBalance;
          case 'currentGroup':
            return row.currentGroup.toLowerCase();
          case 'correctGroup':
            return row.correctGroup.toLowerCase();
          case 'remarks':
            return row.remarks.toLowerCase();
          default:
            return row.companyBalance;
        }
      };

      const valueA = getValue(a, sortColumn);
      const valueB = getValue(b, sortColumn);

      if (typeof valueA === 'string' || typeof valueB === 'string') {
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
  const pagedRows = sortedRows.slice(startIndex, startIndex + rowsPerPage);

  const visibleColumns = useMemo(() => columnDefs.filter((col) => columnVisibility[col.key]), [columnVisibility]);
  const allColumnsChecked = columnDefs.every((col) => columnVisibility[col.key]);
  const anyColumnHidden = columnDefs.some((col) => !columnVisibility[col.key]);

  const handleExport = useCallback(() => {
    const getExportValue = (row: QueueRow, key: ColumnKey) => {
      switch (key) {
        case 'brand':
          return displayBrand(row.brand);
        case 'shopName':
          return row.account;
        case 'companyBalance':
          return row.companyBalance;
        case 'balanceInside':
          return row.balanceInside;
        case 'discrepancy':
          return row.discrepancy;
        case 'sdpVsBalance':
          return row.sdpVsBalance > 0 ? Math.abs(row.sdpVsBalance) : undefined;
        case 'currentGroup':
          return row.currentGroup;
        case 'correctGroup':
          return row.correctGroup;
        case 'remarks':
          return row.remarks;
      }
    };

    const headers = visibleColumns.map((col) => col.label);
    const data = sortedRows.map((row) => visibleColumns.map((col) => getExportValue(row, col.key)));

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Transfer Queue');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SENDMONEY_TRANSFER_QUEUE_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <header className="sticky top-0 z-30 border-b border-border bg-white/95 py-0 pl-14 pr-4 backdrop-blur-sm dark:bg-[#0d1117]/95 md:px-8">
        <div className="flex h-12 items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-4 w-[3px] rounded-full bg-[color:var(--product-accent)]" />
            <h1 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">Transfer Queue</h1>
            <span className="rounded-full bg-[color:var(--product-accent-soft)] px-2 py-0.5 text-[9px] font-semibold text-[color:var(--product-accent)]">
              Send Money
            </span>
          </div>
          <div className="flex items-center gap-2">
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
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden px-6 pt-4 pb-6">
        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <div className="flex-1 flex flex-col min-h-0 mt-3 bg-white rounded-xl border border-border overflow-hidden dark:bg-[#2a2a2d]">
            <div className="shrink-0 px-3 py-2 border-b border-border bg-muted/20 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {loading ? (
                  <div className="h-5 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                ) : (
                  <div className="flex items-center gap-1.5 rounded-md bg-[color:var(--product-accent-soft)] px-2.5 py-1">
                    <span className="text-[10px] font-medium text-[color:var(--product-accent)]">For Transfer</span>
                    <span className="text-[11px] font-bold tabular-nums text-[color:var(--product-accent)]">{filteredRows.length.toLocaleString('en-PH')}</span>
                  </div>
                )}
                <div className="flex w-full min-w-[140px] flex-1 items-center gap-2 rounded-lg border border-border bg-white px-3 py-1.5 dark:bg-[#2a2a2d] sm:w-52 sm:flex-none">
                  {loading ? (
                    <div className="h-3 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  ) : (
                    <>
                      <Search size={14} className="text-muted-foreground" />
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
                      ref={columnButtonRef}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = columnButtonRef.current?.getBoundingClientRect();
                        if (rect) {
                          const dropdownWidth = 224;
                          const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                          setColumnMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                        }
                        setColumnMenuOpen((current) => !current);
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium border rounded-lg hover:bg-white transition-colors ${anyColumnHidden ? 'border-[color:var(--product-accent)]/40 text-[color:var(--product-accent)]' : 'border-border text-foreground'}`}
                    >
                      <Filter size={14} />
                      Filter
                    </button>
                  )}
                  {columnMenuOpen && typeof document !== 'undefined' && createPortal(
                    <div
                      ref={columnDropdownRef}
                      style={{ position: 'fixed', top: columnMenuPos.top, left: columnMenuPos.left }}
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
                    <span className="tabular-nums text-[10px] text-muted-foreground">{currentPage} / {totalPages}</span>
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
            <div className="hidden flex-1 min-h-0 overflow-y-auto overflow-x-scroll sm:block">
              <table className="w-full table-fixed text-xs">
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
                        className={headerCellClasses(col.key, sortColumn === col.key)}>
                        {loading ? (
                          <div className="mx-auto h-5 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        ) : col.key === 'brand' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <span>{col.label}</span>
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
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyBrandUnchecked ? 'bg-[color:var(--product-accent-soft)] text-[color:var(--product-accent)]' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
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
                                <div className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Brand</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allBrandsChecked}
                                      onChange={() => {
                                        const nextValue = !allBrandsChecked;
                                        setBrandFilter(Object.fromEntries(brandOptions.map((name) => [name, nextValue])));
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {brandOptions.map((brand) => (
                                    <label key={brand} className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={isBrandChecked(brand)}
                                        onChange={() => {
                                          setBrandFilter((current) => ({ ...current, [brand]: !isBrandChecked(brand) }));
                                        }}
                                      />
                                      <span>{displayBrand(brand)}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>,
                              document.body
                            )}
                          </div>
                        ) : col.key === 'correctGroup' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <span>{col.label}</span>
                            <button
                              type="button"
                              ref={correctGroupButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                const rect = correctGroupButtonRef.current?.getBoundingClientRect();
                                if (rect) {
                                  const dropdownWidth = 288;
                                  const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                                  setCorrectGroupMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                                }
                                setCorrectGroupMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyCorrectGroupUnchecked ? 'bg-[color:var(--product-accent-soft)] text-[color:var(--product-accent)]' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              {anyCorrectGroupUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedCorrectGroupCount}
                                </span>
                              ) : (
                                <ChevronUp
                                  size={12}
                                  className={`transition-transform duration-150 ease-in-out ${correctGroupMenuOpen ? 'rotate-180' : ''} opacity-70`}
                                />
                              )}
                            </button>
                            {correctGroupMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={correctGroupDropdownRef}
                                style={{ position: 'fixed', top: correctGroupMenuPos.top, left: correctGroupMenuPos.left }}
                                className="z-[9999] w-72 max-w-[90vw] rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Correct Group</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allCorrectGroupsChecked}
                                      onChange={() => {
                                        const nextValue = !allCorrectGroupsChecked;
                                        setCorrectGroupFilter(Object.fromEntries(correctGroupOptions.map((name) => [name, nextValue])));
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {correctGroupOptions.map((group) => (
                                    <label key={group} className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={isCorrectGroupChecked(group)}
                                        onChange={() => {
                                          setCorrectGroupFilter((current) => ({ ...current, [group]: !isCorrectGroupChecked(group) }));
                                        }}
                                      />
                                      <span>{group}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>,
                              document.body
                            )}
                          </div>
                        ) : (
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
                            className="flex w-full items-center justify-center gap-1.5 transition hover:opacity-80"
                          >
                            <span>{col.label}</span>
                            <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                          </button>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 18 }).map((_, rowIndex) => (
                      <tr key={rowIndex}>
                        {visibleColumns.map((col) => {
                          const widths = rowSkeletonWidths[col.key];
                          const width = widths[rowIndex % widths.length];
                          return (
                            <td key={col.key} className="px-3 py-1.5">
                              <div className={`mx-auto h-2.5 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700 ${width}`} />
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  ) : pagedRows.length > 0 ? pagedRows.map((row, i) => (
                    <tr key={row.key} className={`border-b border-border last:border-0 transition-colors hover:bg-muted/10 ${i % 2 === 1 ? 'bg-muted/5' : ''}`}>
                      {visibleColumns.map((col) => renderCell(row, col.key))}
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={Math.max(visibleColumns.length, 1)} className="px-3 py-8 text-center text-[11px] text-muted-foreground">
                        No accounts need transfer.
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
                  pagedRows.map((row) => {
                    const showAgent = columnVisibility.shopName;
                    const showBrand = columnVisibility.brand;
                    const showBalance = columnVisibility.companyBalance;
                    const numericFields = visibleColumns.filter((col) =>
                      (['balanceInside', 'discrepancy', 'sdpVsBalance'] as ColumnKey[]).includes(col.key)
                    );
                    const showCurrentGroup = columnVisibility.currentGroup;
                    const showCorrectGroup = columnVisibility.correctGroup;
                    const showRemarks = columnVisibility.remarks;
                    return (
                      <div key={row.key} className="rounded-xl border border-border bg-white p-3.5 dark:bg-[#2a2a2d]">
                        {(showAgent || showBrand) && (
                          <div className="flex items-start justify-between gap-2">
                            {showAgent && <p className="min-w-0 truncate text-sm font-bold text-foreground">{row.account}</p>}
                            {showBrand && <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{displayBrand(row.brand)}</span>}
                          </div>
                        )}

                        {showBalance && (
                          <div className={`flex items-baseline justify-between ${(showAgent || showBrand) ? 'mt-2.5' : ''}`}>
                            <span className="text-[10px] font-medium text-muted-foreground">Company Balance</span>
                            <span className={`text-lg font-bold tabular-nums ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                              {displayNum(row.companyBalance)}
                            </span>
                          </div>
                        )}

                        {numericFields.length > 0 && (
                          <div className={`grid grid-cols-3 gap-2 ${(showAgent || showBrand || showBalance) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            {numericFields.map((col) => {
                              const { value, className } = mobileNumericField(row, col.key);
                              return (
                                <div key={col.key}>
                                  <p className="text-[9px] font-medium text-muted-foreground">{col.label}</p>
                                  <p className={`text-[11px] font-semibold tabular-nums ${className}`}>{value}</p>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {(showCurrentGroup || showCorrectGroup) && (
                          <div className={`space-y-1.5 ${(showAgent || showBrand || showBalance || numericFields.length > 0) ? 'mt-2.5 border-t border-border pt-2.5' : ''}`}>
                            {showCurrentGroup && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">Current Group</p>
                                <p className="text-[11px] text-muted-foreground">{row.currentGroup}</p>
                              </div>
                            )}
                            {showCorrectGroup && (
                              <div>
                                <p className="text-[9px] font-medium text-muted-foreground">Correct Group</p>
                                <p className="text-[11px] font-medium text-foreground">{row.correctGroup}</p>
                              </div>
                            )}
                          </div>
                        )}

                        {showRemarks && row.remarks && (
                          <p className="mt-2 text-[10px] text-muted-foreground">{row.remarks}</p>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="px-3 py-8 text-center text-[11px] text-muted-foreground">
                    No accounts need transfer.
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
