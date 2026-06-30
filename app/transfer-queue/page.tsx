'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ChevronDown, ChevronUp, Download, Filter, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import ThemeToggle from '../components/ThemeToggle';
import { rawVal } from '@/app/lib/format';

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

const EXCLUDED_SDP_LEADERS = [
  'AFF JAR', 'AIMAN', 'ALADDIN', 'JISAN', 'MIR', 'MR LEE',
  'MUNIM', 'NIHJUM', 'NURNOBY', 'ONEMEN', 'OSMAN', 'MOTIN',
  'ROSE', 'SAM', 'XYZ', 'SHAKIL', 'SHARIF', 'SVEN', 'TANVIR', 'ZUBAIR',
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

const EXCLUDED_WALLET_STATUSES = ['Wallet With Issue', 'Disconnected', 'No Record'];

type Condition = {
  sdpGt30000?: boolean;
  discrepancyGt20000?: boolean;
  companyBalanceLt20000?: boolean;
  companyBalanceLt90000?: boolean;
  companyBalanceBetween35kAnd180k?: boolean;
  companyBalanceGt200000?: boolean;
  companyBalanceGt90000?: boolean;
};

type Rule = { groupName: string; condition: Condition };
type Base = { base: string; rules: Rule[] };

const SOLO_DAY = (prefix: string): Rule[] => [
  { groupName: `${prefix}-SOLO - DAY DP + WD`, condition: { companyBalanceLt90000: true } },
  { groupName: `${prefix}-SOLO - DAY WD`, condition: { sdpGt30000: true, discrepancyGt20000: true, companyBalanceGt90000: true } },
];

const SOLO_247 = (prefix: string): Rule[] => [
  { groupName: `${prefix}-SOLO- 24/7 Low balance DP Only`, condition: { companyBalanceLt20000: true } },
  { groupName: `${prefix}-SOLO - 24/7 DP + WD`, condition: { companyBalanceBetween35kAnd180k: true } },
  { groupName: `${prefix}-SOLO- 24/7 WD Only`, condition: { companyBalanceGt200000: true } },
  { groupName: `${prefix}-SOLO - 24/7 Discrepancy / Clear Balance`, condition: { sdpGt30000: true, discrepancyGt20000: true } },
];

const BASES: Base[] = [
  { base: 'B1 SOLO DAY', rules: SOLO_DAY('B1') },
  { base: 'B1 SOLO 24/7', rules: SOLO_247('B1') },

  { base: 'B2 SOLO DAY', rules: SOLO_DAY('B2') },
  { base: 'B2 SOLO 24/7', rules: SOLO_247('B2') },

  { base: 'B3 SOLO 24/7', rules: SOLO_247('B3') },

  { base: 'B4 SOLO DAY', rules: SOLO_DAY('B4') },
  { base: 'B4 SOLO 24/7', rules: SOLO_247('B4') },

  { base: 'B5 SOLO DAY', rules: SOLO_DAY('B5') },
  { base: 'B5 SOLO 24/7', rules: SOLO_247('B5') },

  { base: 'J1 SOLO DAY', rules: SOLO_DAY('J1') },
  { base: 'J1 SOLO 24/7', rules: SOLO_247('J1') },

  {
    base: 'K1 SOLO DAY',
    rules: [
      { groupName: 'K1 - SOLO - DAY DP + WD', condition: { companyBalanceLt90000: true } },
      { groupName: 'K1 - SOLO - DAY WD', condition: { sdpGt30000: true, discrepancyGt20000: true, companyBalanceGt90000: true } },
    ],
  },
  { base: 'K1 SOLO 24/7', rules: SOLO_247('K1') },

  {
    base: 'M1 Day',
    rules: [
      { groupName: 'M1 - Day Low balance DP Only', condition: { companyBalanceLt20000: true } },
      { groupName: 'M1 - Day DP + WD', condition: { companyBalanceBetween35kAnd180k: true } },
      { groupName: 'M1 - Day WD Only', condition: { companyBalanceGt200000: true } },
      { groupName: 'M1 - Day Discrepancy / Clear Balance', condition: { sdpGt30000: true, discrepancyGt20000: true } },
    ],
  },
  {
    base: 'M1 24/7',
    rules: [
      { groupName: 'M1 - 24/7 Low Balance DP Only', condition: { companyBalanceLt20000: true } },
      { groupName: 'M1 - 24/7 DP + WD', condition: { companyBalanceBetween35kAnd180k: true } },
      { groupName: 'M1 - 24/7 WD Only', condition: { companyBalanceGt200000: true } },
      { groupName: 'M1 - 24/7 Discrepancy / Clear Balance', condition: { sdpGt30000: true, discrepancyGt20000: true } },
    ],
  },

  {
    base: 'M2 SOLO DAY',
    rules: [
      { groupName: 'M2 - SOLO - DAY DP + WD', condition: { companyBalanceLt90000: true } },
      { groupName: 'M2 - SOLO - DAY WD', condition: { sdpGt30000: true, discrepancyGt20000: true, companyBalanceGt90000: true } },
    ],
  },
  { base: 'M2 SOLO 24/7', rules: SOLO_247('M2') },

  { base: 'T1 SOLO DAY', rules: SOLO_DAY('T1') },
  { base: 'T1 SOLO 24/7', rules: SOLO_247('T1') },
];

const BRAND_CODES = ['M1', 'M2', 'B1', 'B2', 'B3', 'B4', 'B5', 'K1', 'J1', 'T1'];
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

function resolveBrand(groups: string[], agentName: string): string {
  const brand = computeBrand(groups);
  if (brand !== '−') return brand;
  return BRAND_CODES.find((code) => agentName.toUpperCase().includes(code)) ?? '−';
}

function normalizeGroup(s: string): string {
  return s.toUpperCase().replace(/[\s-]+/g, '');
}

function stripAccountPrefix(raw: string): string {
  const trimmed = raw.trim();
  const idx = trimmed.indexOf(' - ');
  if (idx === -1) return trimmed;
  return trimmed.slice(idx + 3).trim();
}

function determineBaseLabel(rawGroup: string): string | null {
  const trimmed = rawGroup.trim();
  if (!trimmed || trimmed === '-') return null;

  const upper = trimmed.toUpperCase();
  const noSpaces = upper.replace(/[\s-]+/g, '');
  const code = BRAND_CODES.find((c) => noSpaces.startsWith(c));
  if (!code) return null;

  const is247 = upper.includes('24/7');
  const isDay = upper.includes('DAY');
  if (!is247 && !isDay) return null;
  const period = is247 ? '24/7' : 'DAY';

  if (code === 'M1') return period === 'DAY' ? 'M1 Day' : 'M1 24/7';
  return `${code} SOLO ${period}`;
}

function checkCondition(condition: Condition, companyBalance: number, sdpVsBalance: number, discrepancy: number): boolean {
  if (condition.sdpGt30000 && !(sdpVsBalance > 30000)) return false;
  if (condition.discrepancyGt20000 && !(discrepancy > 20000)) return false;
  if (condition.companyBalanceLt20000 && !(companyBalance < 20000)) return false;
  if (condition.companyBalanceLt90000 && !(companyBalance < 90000)) return false;
  if (condition.companyBalanceBetween35kAnd180k && !(companyBalance >= 35000 && companyBalance <= 180000)) return false;
  if (condition.companyBalanceGt200000 && !(companyBalance > 200000)) return false;
  if (condition.companyBalanceGt90000 && !(companyBalance > 90000)) return false;
  return true;
}

function reasonForCondition(condition: Condition): string {
  if (condition.companyBalanceLt20000) return 'Company balance is below 20,000';
  if (condition.companyBalanceBetween35kAnd180k) return 'Company balance is within normal range';
  if (condition.companyBalanceGt200000) return 'Company balance exceeded 200,000';
  if (condition.companyBalanceLt90000) return 'Company balance is below 90,000';
  if (condition.companyBalanceGt90000) return 'Company balance exceeded 90,000';
  return '';
}

function resolveCorrectGroup(rawGroup: string, companyBalance: number, sdpVsBalance: number, discrepancy: number): { groupName: string; remarks: string } | null {
  const baseLabel = determineBaseLabel(rawGroup);
  if (!baseLabel) return null;

  const base = BASES.find((b) => b.base === baseLabel);
  if (!base) return null;

  const specialRule = base.rules.find((rule) => rule.condition.discrepancyGt20000 || rule.condition.sdpGt30000);
  if (specialRule && discrepancy > 20000) return { groupName: specialRule.groupName, remarks: 'Discrepancy is higher than 20,000' };
  if (specialRule && sdpVsBalance > 30000) return { groupName: specialRule.groupName, remarks: 'SDP VS Balance exceeded 30,000' };

  const balanceRules = base.rules.filter((rule) => !rule.condition.discrepancyGt20000 && !rule.condition.sdpGt30000);
  const matched = balanceRules.find((rule) => checkCondition(rule.condition, companyBalance, sdpVsBalance, discrepancy));
  return matched ? { groupName: matched.groupName, remarks: reasonForCondition(matched.condition) } : null;
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
  { key: 'companyBalance', label: 'Company Money' },
  { key: 'balanceInside', label: 'Balance Inside' },
  { key: 'discrepancy', label: 'Discrepancy' },
  { key: 'sdpVsBalance', label: 'SDP VS Balance' },
  { key: 'currentGroup', label: 'Current Group' },
  { key: 'correctGroup', label: 'Correct Group' },
  { key: 'remarks', label: 'Remarks' },
];

const columnWidths: Record<ColumnKey, string> = {
  brand: '7%',
  shopName: '14%',
  companyBalance: '11%',
  balanceInside: '11%',
  discrepancy: '10%',
  sdpVsBalance: '11%',
  currentGroup: '13%',
  correctGroup: '13%',
  remarks: '10%',
};

const headerSkeletonWidths: Record<ColumnKey, string> = {
  brand: 'w-10',
  shopName: 'w-14',
  companyBalance: 'w-20',
  balanceInside: 'w-20',
  discrepancy: 'w-16',
  sdpVsBalance: 'w-20',
  currentGroup: 'w-24',
  correctGroup: 'w-24',
  remarks: 'w-14',
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

function headerCellClasses(active: boolean) {
  const color = active ? 'text-indigo-600 dark:text-indigo-400' : 'text-foreground';
  return `group text-center px-3 py-2 text-[11px] font-semibold whitespace-nowrap ${color}`;
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
    <ChevronUp size={10} className="text-indigo-600 dark:text-indigo-400" />
  ) : (
    <ChevronDown size={10} className="text-indigo-600 dark:text-indigo-400" />
  );
}

function renderCell(row: QueueRow, key: ColumnKey) {
  const base = 'whitespace-nowrap overflow-hidden text-ellipsis text-[9px] text-center px-3 py-1';
  switch (key) {
    case 'brand':
      return <td key={key} className={`${base} text-slate-700 dark:text-slate-300`}>{row.brand}</td>;
    case 'shopName':
      return <td key={key} className={`${base} text-slate-700 dark:text-slate-300`}>{row.account}</td>;
    case 'companyBalance':
      return (
        <td key={key} className={`${base} ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>
          {displayNum(row.companyBalance)}
        </td>
      );
    case 'balanceInside':
      return (
        <td key={key} className={`${base} ${row.balanceInside < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>
          {displayNum(row.balanceInside)}
        </td>
      );
    case 'discrepancy':
      return (
        <td key={key} className={`${base} ${row.discrepancy < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>
          {displayNum(row.discrepancy)}
        </td>
      );
    case 'sdpVsBalance':
      return (
        <td key={key} className={`${base} text-slate-700 dark:text-slate-300`}>
          {row.sdpVsBalance > 0 ? displayNum(Math.abs(row.sdpVsBalance)) : '−'}
        </td>
      );
    case 'currentGroup':
      return <td key={key} className={`${base} text-slate-700 dark:text-slate-300`}>{row.currentGroup}</td>;
    case 'correctGroup':
      return <td key={key} className={`${base} text-slate-700 dark:text-slate-300`}>{row.correctGroup}</td>;
    case 'remarks':
      return <td key={key} className={`${base} text-slate-500`}>{row.remarks}</td>;
  }
}

export default function TransferQueue() {
  const [queueRows, setQueueRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
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
          account: rawVal(row[7]),
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
          sdpVsBalance: computeSdpVsBalance(opening.leader, opening.sdp, sdpNum, companyBalance),
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
        const resolved = resolveCorrectGroup(currentGroup, info.companyBalance, info.sdpVsBalance, info.discrepancy);
        if (!resolved) return;
        if (normalizeGroup(currentGroup) === normalizeGroup(resolved.groupName)) return;

        queue.push({
          key: `${bal.walletName}-${index}`,
          shopName: bal.walletName,
          account: stripAccountPrefix(bal.account),
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
      setLastUpdated(new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true }));
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
            return row.brand.toLowerCase();
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
          return row.brand;
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
    XLSX.writeFile(workbook, `SSP1_TRANSFER_QUEUE_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  return (
    <div className="min-h-screen w-full bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <header className="sticky top-0 z-30 border-b border-[#e5e5e7] bg-white px-4 py-2 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] md:px-8">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-medium text-foreground">Transfer Queue</h1>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="h-1 w-1 rounded-full bg-emerald-500" />
              {loading ? '—' : (lastUpdated || '—')}
            </span>
            <ThemeToggle />
            <button
              onClick={fetchData}
              disabled={spinning || loading}
              className="flex items-center gap-1.5 px-3 py-2 text-[10px] font-medium text-indigo-600 border border-border rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={spinning ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="px-6 pt-4 pb-6">
        {error && (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-200 px-5 py-4 text-sm text-rose-600 dark:border-rose-900/60 dark:text-rose-300">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {!error && (
          <div className="mb-1">
            {loading ? (
              <div className="h-2.5 w-24 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse" />
            ) : (
              <span className="text-[11px] font-semibold text-foreground">For Transfer: <span className="text-indigo-600">{filteredRows.length.toLocaleString('en-PH')}</span></span>
            )}
          </div>
        )}

        {!error && (
          <div className="bg-white rounded-xl border border-border overflow-hidden dark:bg-[#2a2a2d]">
            <div className="px-3 py-1 border-b border-border bg-muted/20 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="flex w-52 items-center gap-2 bg-white border border-border rounded-full px-4 py-1.5 dark:bg-[#2a2a2d]">
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
                          setColumnMenuPos({ top: rect.bottom + 8, left: rect.left });
                        }
                        setColumnMenuOpen((current) => !current);
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium border rounded-lg hover:bg-white transition-colors ${anyColumnHidden ? 'border-indigo-200 text-indigo-700 dark:border-indigo-900/50 dark:text-indigo-300' : 'border-border text-foreground'}`}
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
              <div className="flex items-center gap-3">
                {loading ? (
                  <div className="h-2.5 w-32 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse" />
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">Page {currentPage} of {totalPages}</span>
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                      disabled={currentPage === 1}
                      className="px-2.5 py-1.5 text-[10px] font-medium text-foreground border border-border rounded-lg hover:bg-white transition-colors disabled:opacity-50"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                      disabled={currentPage === totalPages}
                      className="px-2.5 py-1.5 text-[10px] font-medium text-foreground border border-border rounded-lg hover:bg-white transition-colors disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                )}
                {loading && <div className="h-7 w-20 animate-pulse rounded-xl bg-slate-200 dark:bg-slate-700" />}
                {!loading && (
                  <button
                    type="button"
                    onClick={handleExport}
                    title="Export to Excel"
                    className="p-1.5 rounded-lg hover:bg-white transition-colors border border-border text-foreground"
                  >
                    <Download size={14} />
                  </button>
                )}
              </div>
            </div>
            <div className="max-h-[calc(100vh-140px)] overflow-y-auto overflow-x-scroll">
              <table className="w-full table-fixed text-xs">
                <colgroup>
                  {visibleColumns.map((col) => (
                    <col key={col.key} style={{ width: columnWidths[col.key] }} />
                  ))}
                </colgroup>
                <thead className="sticky top-0 z-[50] border-b border-border bg-white dark:bg-[#2a2a2d]">
                  <tr>
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        style={{ width: columnWidths[col.key] }}
                        className={headerCellClasses(sortColumn === col.key)}>
                        {loading ? (
                          <div className={`mx-auto h-2.5 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700 ${headerSkeletonWidths[col.key]}`} />
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
                                      <span>{brand}</span>
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
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyCorrectGroupUnchecked ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/30 dark:text-indigo-200' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
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
                            className="flex w-full items-center justify-center gap-1.5 text-center transition hover:opacity-80"
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
                    Array.from({ length: 12 }).map((_, rowIndex) => (
                      <tr key={rowIndex} className="bg-white dark:bg-[#2a2a2d]">
                        {visibleColumns.map((col) => {
                          const widths = rowSkeletonWidths[col.key];
                          const width = widths[rowIndex % widths.length];
                          return (
                            <td key={col.key} className="px-3 py-1">
                              <div className={`mx-auto h-2.5 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800 ${width}`} />
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  ) : pagedRows.length > 0 ? pagedRows.map((row) => (
                    <tr key={row.key} className="bg-white dark:bg-[#2a2a2d]">
                      {visibleColumns.map((col) => renderCell(row, col.key))}
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={Math.max(visibleColumns.length, 1)} className="px-3 py-8 text-center text-[9px] text-[#6b7280] dark:text-[#a0a0a0]">
                        No accounts need transfer.
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
