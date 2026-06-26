'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ChevronDown, ChevronUp, Download, Filter, Loader2, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import ThemeToggle from '../components/ThemeToggle';
import { rawVal } from '@/app/lib/format';

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

function parseNumber(val: string): number {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
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

type ColumnKey = 'brand' | 'leader' | 'walletName' | 'sdp' | 'opening' | 'totalDP' | 'totalWD' | 'topUp' | 'settlement' | 'companyBalance' | 'balanceInside' | 'agentWithdrawal' | 'sdpVsBalance' | 'walletStatus';

const columnDefs: { key: ColumnKey; label: string; sortable: boolean }[] = [
  { key: 'brand', label: 'Brand', sortable: false },
  { key: 'leader', label: 'Leader', sortable: false },
  { key: 'walletName', label: 'Wallet Name', sortable: true },
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
  { key: 'walletStatus', label: 'Wallet Status', sortable: true },
];

const columnWidths: Record<ColumnKey, string> = {
  brand: '70px',
  leader: '90px',
  walletName: '220px',
  sdp: '100px',
  opening: '110px',
  totalDP: '110px',
  totalWD: '110px',
  topUp: '110px',
  settlement: '110px',
  companyBalance: '140px',
  balanceInside: '120px',
  agentWithdrawal: '130px',
  sdpVsBalance: '130px',
  walletStatus: '130px',
};

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

function headerCellClasses(isSorted: boolean) {
  const bg = isSorted ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'bg-white dark:bg-[#2a2a2d]';
  const color = isSorted ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400';
  const rounded = isSorted ? 'rounded-md' : '';
  return `sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 px-3 py-1 text-center text-[10px] font-semibold uppercase dark:border-slate-700 ${bg} ${color} ${rounded}`;
}

function renderCell(row: MergedRow, key: ColumnKey) {
  switch (key) {
    case 'brand':
      return <td key={key} className="whitespace-nowrap px-3 py-1 text-center text-[9px] text-slate-700 dark:text-slate-300">{row.brand}</td>;
    case 'leader':
      return <td key={key} className="whitespace-nowrap px-3 py-1 text-center text-[9px] text-slate-700 dark:text-slate-300">{row.leader}</td>;
    case 'walletName':
      return <td key={key} className="whitespace-nowrap px-3 py-1 text-center text-[9px] font-bold text-slate-900 dark:text-white">{row.agentName}</td>;
    case 'sdp':
      return <td key={key} className="whitespace-nowrap px-3 py-1 text-center text-[9px] text-slate-700 dark:text-slate-300">{displayNum(row.sdp)}</td>;
    case 'opening':
      return <td key={key} className="whitespace-nowrap px-3 py-1 text-center text-[9px] text-slate-700 dark:text-slate-300">{displayNum(row.openingBal)}</td>;
    case 'totalDP':
      return <td key={key} className="whitespace-nowrap px-3 py-1 text-center text-[9px] text-slate-700 dark:text-slate-300">{displayNum(row.agentTotalDP)}</td>;
    case 'totalWD':
      return <td key={key} className="whitespace-nowrap px-3 py-1 text-center text-[9px] text-slate-700 dark:text-slate-300">{displayNum(row.agentTotalWD)}</td>;
    case 'topUp':
      return <td key={key} className="whitespace-nowrap px-3 py-1 text-center text-[9px] text-slate-700 dark:text-slate-300">{displayNum(row.totalTopUp)}</td>;
    case 'settlement': {
      const settlementDisplay = displayNum(row.totalStlm);
      return (
        <td key={key} className="whitespace-nowrap px-3 py-1 text-center text-[9px] text-slate-700 dark:text-slate-300">
          {settlementDisplay}
        </td>
      );
    }
    case 'balanceInside':
      return (
        <td key={key} className="px-3 py-1 text-[9px] text-center text-slate-700 dark:text-slate-300">
          {displayNum(String(row.balanceInside ?? 0))}
        </td>
      );
    case 'agentWithdrawal':
      return (
        <td key={key} className="px-3 py-1 text-[9px] text-center text-slate-700 dark:text-slate-300">
          {displayNum(String(row.agentWithdrawal))}
        </td>
      );
    case 'sdpVsBalance':
      return (
        <td key={key} className="px-3 py-1 text-[9px] text-center text-slate-700 dark:text-slate-300">
          {row.sdpVsBalance > 0 ? displayNum(String(Math.abs(row.sdpVsBalance))) : '−'}
        </td>
      );
    case 'walletStatus':
      return (
        <td key={key} className={`whitespace-nowrap px-3 py-1 text-center text-[9px] ${row.walletStatus === 'No Record' ? 'text-slate-400 dark:text-slate-500' : 'text-slate-700 dark:text-slate-300'}`}>
          {row.walletStatus}
        </td>
      );
    case 'companyBalance':
    default: {
      const companyBalanceDisplay = displayNum(row.runningBalance);
      const companyBalanceColor =
        companyBalanceDisplay === '−'
          ? 'text-slate-900 dark:text-white'
          : row.runningBalance < 0
          ? 'text-rose-600 dark:text-rose-400'
          : 'text-slate-900 dark:text-white';
      return (
        <td key={key} className={`whitespace-nowrap px-3 py-1 text-center text-[9px] font-bold ${companyBalanceColor}`}>
          {companyBalanceDisplay}
        </td>
      );
    }
  }
}

export default function AgentBalance() {
  const [rows, setRows] = useState<MergedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);
  const hasLoadedRef = useRef(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [leaderFilter, setLeaderFilter] = useState<Record<string, boolean>>({});
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [sortColumn, setSortColumn] = useState<ColumnKey>('companyBalance');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [leaderMenuOpen, setLeaderMenuOpen] = useState(false);
  const [leaderMenuPos, setLeaderMenuPos] = useState({ top: 0, left: 0 });
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [brandMenuPos, setBrandMenuPos] = useState({ top: 0, left: 0 });
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [columnMenuPos, setColumnMenuPos] = useState({ top: 0, left: 0 });
  const [columnVisibility, setColumnVisibility] = useState<Record<ColumnKey, boolean>>(
    () => Object.fromEntries(columnDefs.map((col) => [col.key, true])) as Record<ColumnKey, boolean>
  );
  const [walletStatusFilter, setWalletStatusFilter] = useState<Record<string, boolean>>(
    () => Object.fromEntries(WALLET_STATUS_OPTIONS.map((status) => [status, true]))
  );
  const [walletStatusMenuOpen, setWalletStatusMenuOpen] = useState(false);
  const [walletStatusMenuPos, setWalletStatusMenuPos] = useState({ top: 0, left: 0 });
  const [page, setPage] = useState(1);
  const rowsPerPage = 50;
  const leaderButtonRef = useRef<HTMLButtonElement>(null);
  const leaderDropdownRef = useRef<HTMLDivElement>(null);
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandDropdownRef = useRef<HTMLDivElement>(null);
  const columnButtonRef = useRef<HTMLButtonElement>(null);
  const columnDropdownRef = useRef<HTMLDivElement>(null);
  const walletStatusButtonRef = useRef<HTMLButtonElement>(null);
  const walletStatusDropdownRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<number>(0);

  const fetchData = useCallback(async () => {
    scrollRef.current = window.scrollY;
    try {
      setSpinning(true);
      if (!hasLoadedRef.current) {
        setLoading(true);
      }
      setError('');

      const [openingRes, balRes, stlmRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
        fetch(`/api/stlm?t=${Date.now()}`),
      ]);

      if (!openingRes.ok || !balRes.ok || !stlmRes.ok) throw new Error('Failed to fetch');

      const openingText = await openingRes.text();
      const balText = await balRes.text();
      const stlmText = await stlmRes.text();

      const openingRows = parseCsvLines(openingText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          agentName: rawVal(row[0]),
          openingBal: rawVal(row[1]),
          sdp: rawVal(row[2]),
          leader: rawVal(row[3]),
        }))
        .filter((row) => row.agentName && row.agentName !== 'OLD');

      const balRows = parseCsvLines(balText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .map((row) => ({
          walletName: rawVal(row[1]),
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

        if (bal.login.trim().toLowerCase() === 'yes') {
          const balance = parseFloat(bal.balance.replace(/,/g, '')) || 0;
          balanceInsideTotals.set(name, (balanceInsideTotals.get(name) ?? 0) + balance);
        }
      });

      const topUpTotals = new Map<string, number>();
      const stlmTotals = new Map<string, number>();
      parseCsvLines(stlmText)
        .slice(1)
        .filter((row) => row.some((cell) => cell.trim() !== ''))
        .forEach((row) => {
          const topUpAgent = rawVal(row[0]);
          const topUpAmount = rawVal(row[3]);
          if (topUpAgent && topUpAgent !== '-' && topUpAmount && topUpAmount !== '-') {
            const amount = parseFloat(topUpAmount.replace(/,/g, '')) || 0;
            topUpTotals.set(topUpAgent, (topUpTotals.get(topUpAgent) ?? 0) + amount);
          }

          const stlmAgent = rawVal(row[7]);
          const stlmAmount = rawVal(row[8]);
          if (stlmAgent && stlmAgent !== '-' && stlmAmount && stlmAmount !== '-') {
            const amount = parseFloat(stlmAmount.replace(/,/g, '')) || 0;
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
          brand: computeBrand(brandGroups.get(opening.agentName) ?? []),
        };
      });

      setRows(merged);
      hasLoadedRef.current = true;
      setLastUpdated(new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true }));
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.scrollTo({ top: scrollRef.current, behavior: 'instant' });
          });
        });
      }, 50);
    } catch {
      setError('Unable to load data. Check your Google Sheet or network connection.');
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
  }, [searchTerm, leaderFilter, brandFilter, walletStatusFilter, sortColumn, sortDirection]);

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
  const allWalletStatusesChecked = WALLET_STATUS_OPTIONS.every((status) => walletStatusFilter[status]);
  const anyWalletStatusUnchecked = WALLET_STATUS_OPTIONS.some((status) => !walletStatusFilter[status]);

  const leaderOptions = useMemo(() => {
    const leaders = Array.from(new Set(rows.map((row) => row.leader).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    return leaders;
  }, [rows]);

  const isLeaderChecked = (name: string) => leaderFilter[name] !== false;
  const allLeadersChecked = leaderOptions.every((name) => isLeaderChecked(name));
  const anyLeaderUnchecked = leaderOptions.some((name) => !isLeaderChecked(name));

  const brandOptions = useMemo(() => {
    const brands = Array.from(new Set(rows.map((row) => row.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    return brands;
  }, [rows]);

  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const allBrandsChecked = brandOptions.every((name) => isBrandChecked(name));
  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));

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
    if (WALLET_STATUS_OPTIONS.some((status) => !walletStatusFilter[status])) {
      list = list.filter((row) => walletStatusFilter[row.walletStatus]);
    }
    return list;
  }, [leaderFilter, leaderOptions, brandFilter, brandOptions, walletStatusFilter, searchedRows]);

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

      if (sortColumn === 'walletName' || sortColumn === 'leader' || sortColumn === 'walletStatus' || sortColumn === 'brand') {
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
    const headers = [
      'Brand', 'Leader', 'Wallet Name', 'SDP', 'Opening', 'Total DP', 'Total WD',
      'Top Up', 'Settlement', 'Company Balance', 'Balance Inside',
      'Agent Withdrawal', 'SDP VS Balance', 'Wallet Status',
    ];

    const data = sortedRows.map((row) => [
      row.brand,
      row.leader,
      row.agentName,
      numOrBlank(parseNumber(row.sdp)),
      numOrBlank(parseNumber(row.openingBal)),
      numOrBlank(row.agentTotalDP),
      numOrBlank(row.agentTotalWD),
      numOrBlank(row.totalTopUp),
      numOrBlank(row.totalStlm),
      numOrBlank(row.runningBalance),
      numOrBlank(row.balanceInside),
      numOrBlank(row.agentWithdrawal),
      row.sdpVsBalance > 0 ? Math.abs(row.sdpVsBalance) : undefined,
      row.walletStatus,
    ]);

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Agent Balance');

    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `agent-balance-${today}.xlsx`);
  }, [sortedRows]);

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  return (
    <div className="min-h-screen overflow-y-hidden bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white">
      <header className="border-b border-[#e5e5e7] bg-white px-4 py-2 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] md:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Agent Balance</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 rounded-xl border border-[#e5e5e7] px-2 py-1.5 text-[11px] text-[#6b7280] dark:border-[#3a3a3d] dark:text-[#a0a0a0]">
              <Search size={12} />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                disabled={loading}
                className="w-32 bg-transparent outline-none disabled:opacity-50 md:w-48"
                placeholder="Search"
              />
            </label>
            <span className="flex items-center gap-1.5 text-[11px] text-[#6b7280] dark:text-[#a0a0a0]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              {loading ? '—' : (lastUpdated || '—')}
            </span>
            <ThemeToggle />
            <button
              onClick={fetchData}
              disabled={spinning || loading}
              className="flex items-center gap-2 rounded-xl border border-[#e5e5e7] px-2 py-1.5 text-[11px] font-medium text-[#6b7280] transition-all disabled:opacity-50 dark:border-[#3a3a3d] dark:text-[#a0a0a0]"
            >
              <RefreshCw size={12} className={spinning ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="relative space-y-2 p-3">
        {loading && (
          <div
            className="fixed z-[9998] flex items-center justify-center bg-white/30 dark:bg-black/30"
            style={{ top: 0, left: '256px', right: 0, bottom: 0 }}
          >
            <Loader2 size={28} className="animate-spin text-indigo-500" />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-200 px-5 py-4 text-sm text-rose-600 dark:border-rose-900/60 dark:text-rose-300">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {!error && (
          <div className="overflow-hidden rounded-xl border border-[#e5e5e7] bg-white dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
            <div className="flex items-center justify-between gap-3 border-b border-[#e5e5e7] px-2 py-1.5 dark:border-[#3a3a3d]">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{sortedRows.length} accounts</span>
              <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 rounded-xl border border-[#e5e5e7] px-2 py-0.5 dark:border-[#3a3a3d]">
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={currentPage === 1}
                  className="rounded-xl px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 transition disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300"
                >
                  Previous
                </button>
                <span className="text-[10px] text-slate-500 dark:text-slate-400">Page {currentPage} of {totalPages}</span>
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  disabled={currentPage === totalPages}
                  className="rounded-xl px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 transition disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300"
                >
                  Next
                </button>
              </div>
              <div className="relative">
                  <button
                    type="button"
                    ref={columnButtonRef}
                    onClick={(event) => {
                      event.stopPropagation();
                      const rect = columnButtonRef.current?.getBoundingClientRect();
                      if (rect) {
                        setColumnMenuPos({ top: rect.bottom + 8, left: rect.right - 224 });
                      }
                      setColumnMenuOpen((current) => !current);
                    }}
                    className={`flex items-center justify-center rounded-xl border p-1.5 transition ${anyColumnHidden ? 'border-indigo-200 text-indigo-700 dark:border-indigo-900/50 dark:text-indigo-300' : 'border-[#e5e5e7] text-[#6b7280] dark:border-[#3a3a3d] dark:text-[#a0a0a0]'}`}
                  >
                    <Filter size={14} />
                  </button>
                  {columnMenuOpen && typeof document !== 'undefined' && createPortal(
                    <div
                      ref={columnDropdownRef}
                      style={{ position: 'fixed', top: columnMenuPos.top, left: columnMenuPos.left }}
                      className="z-[1000] w-56 rounded-xl border border-slate-200 bg-white p-3 shadow-md dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="mb-2 border-b border-slate-200 pb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-[#3a3a3d] dark:text-slate-400">Columns</div>
                      <label className="flex w-full items-center gap-2 rounded px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800/50">
                        <input
                          type="checkbox"
                          className="accent-indigo-500"
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
                        <label key={col.key} className="flex w-full items-center gap-2 rounded px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800/50">
                          <input
                            type="checkbox"
                            className="accent-indigo-500"
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
                <button
                  type="button"
                  onClick={handleExport}
                  title="Export to Excel"
                  className="flex items-center justify-center rounded-xl border border-[#e5e5e7] p-1.5 text-[#6b7280] transition hover:bg-slate-50 dark:border-[#3a3a3d] dark:text-[#a0a0a0] dark:hover:bg-white/10"
                >
                  <Download size={14} />
                </button>
              </div>
            </div>
            <div className="max-h-[calc(100vh-140px)] overflow-y-auto overflow-x-scroll">
              <table className="w-full table-auto text-xs">
                <colgroup>
                  {visibleColumns.map((col) => (
                    <col key={col.key} style={{ width: columnWidths[col.key] }} />
                  ))}
                </colgroup>
                <thead className="sticky top-0 z-10 border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-[#2a2a2d]">
                  <tr className="text-center text-[10px] font-semibold uppercase text-slate-500 dark:text-slate-400">
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        style={{ minWidth: columnWidths[col.key] }}
                        className={headerCellClasses(sortColumn === col.key)}>
                        {col.key === 'brand' ? (
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
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyBrandUnchecked ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/30 dark:text-indigo-200' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              <Filter size={12} className={anyBrandUnchecked ? 'opacity-100' : 'opacity-70'} />
                            </button>
                            {brandMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={brandDropdownRef}
                                style={{ position: 'fixed', top: brandMenuPos.top, left: brandMenuPos.left }}
                                className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Filter</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
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
                                    <label key={brand} className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
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
                            <span>{col.label}</span>
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
                              <Filter size={12} className={anyLeaderUnchecked ? 'opacity-100' : 'opacity-70'} />
                            </button>
                            {leaderMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={leaderDropdownRef}
                                style={{ position: 'fixed', top: leaderMenuPos.top, left: leaderMenuPos.left }}
                                className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Filter</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
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
                                    <label key={leader} className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
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
                        ) : col.key === 'walletStatus' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                if (sortColumn === 'walletStatus') {
                                  setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
                                } else {
                                  setSortColumn('walletStatus');
                                  setSortDirection('asc');
                                }
                              }}
                              className="flex items-center gap-1 text-center transition hover:opacity-80"
                            >
                              <span>{col.label}</span>
                              <SortIcon active={sortColumn === 'walletStatus'} direction={sortDirection} />
                            </button>
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
                              <Filter size={12} className={anyWalletStatusUnchecked ? 'opacity-100' : 'opacity-70'} />
                            </button>
                            {walletStatusMenuOpen && typeof document !== 'undefined' && createPortal(
                              <div
                                ref={walletStatusDropdownRef}
                                style={{ position: 'fixed', top: walletStatusMenuPos.top, left: walletStatusMenuPos.left }}
                                className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Filter</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allWalletStatusesChecked}
                                      onChange={() => {
                                        const nextValue = !allWalletStatusesChecked;
                                        setWalletStatusFilter(
                                          Object.fromEntries(WALLET_STATUS_OPTIONS.map((status) => [status, nextValue]))
                                        );
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {WALLET_STATUS_OPTIONS.map((status) => (
                                    <label key={status} className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={walletStatusFilter[status]}
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
                            className="flex w-full items-center justify-center gap-1.5 text-center transition hover:opacity-80"
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
                  {pagedRows.length > 0 ? pagedRows.map((row, i) => (
                    <tr
                      key={row.agentName || i}
                      className="bg-white dark:bg-[#2a2a2d]"
                    >
                      {visibleColumns.map((col) => renderCell(row, col.key))}
                    </tr>
                  )) : !loading && (
                    <tr>
                      <td colSpan={Math.max(visibleColumns.length, 1)} className="px-3 py-8 text-center text-[9px] text-[#6b7280] dark:text-[#a0a0a0]">
                        No matching accounts found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}