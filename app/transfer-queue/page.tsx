'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Download, Filter, RefreshCw, Search } from 'lucide-react';
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
  brand: string;
  currentGroup: string;
  correctGroup: string;
  companyBalance: number;
  discrepancy: number;
  sdpVsBalance: number;
  balanceInside: number;
  remarks: string;
};

export default function TransferQueue() {
  const [queueRows, setQueueRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [currentGroupFilter, setCurrentGroupFilter] = useState<Record<string, boolean>>({});
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [brandMenuPos, setBrandMenuPos] = useState({ top: 0, left: 0 });
  const [currentGroupMenuOpen, setCurrentGroupMenuOpen] = useState(false);
  const [currentGroupMenuPos, setCurrentGroupMenuPos] = useState({ top: 0, left: 0 });
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandDropdownRef = useRef<HTMLDivElement>(null);
  const currentGroupButtonRef = useRef<HTMLButtonElement>(null);
  const currentGroupDropdownRef = useRef<HTMLDivElement>(null);
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
        const resolved = resolveCorrectGroup(currentGroup, info.companyBalance, info.sdpVsBalance, info.discrepancy);
        if (!resolved) return;
        if (normalizeGroup(currentGroup) === normalizeGroup(resolved.groupName)) return;

        queue.push({
          key: `${bal.walletName}-${index}`,
          shopName: bal.walletName,
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
  }, [searchTerm, brandFilter, currentGroupFilter]);

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
    if (!currentGroupMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        currentGroupButtonRef.current && !currentGroupButtonRef.current.contains(target) &&
        currentGroupDropdownRef.current && !currentGroupDropdownRef.current.contains(target)
      ) {
        setCurrentGroupMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [currentGroupMenuOpen]);

  const searchedRows = useMemo(() => {
    const query = searchTerm.toLowerCase();
    if (!query) return queueRows;
    return queueRows.filter((row) =>
      `${row.shopName} ${row.currentGroup} ${row.correctGroup}`.toLowerCase().includes(query)
    );
  }, [queueRows, searchTerm]);

  const brandOptions = useMemo(
    () => Array.from(new Set(queueRows.map((row) => row.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [queueRows]
  );
  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const allBrandsChecked = brandOptions.every((name) => isBrandChecked(name));
  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));

  const currentGroupOptions = useMemo(
    () => Array.from(new Set(queueRows.map((row) => row.currentGroup).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [queueRows]
  );
  const isCurrentGroupChecked = (name: string) => currentGroupFilter[name] !== false;
  const allCurrentGroupsChecked = currentGroupOptions.every((name) => isCurrentGroupChecked(name));
  const anyCurrentGroupUnchecked = currentGroupOptions.some((name) => !isCurrentGroupChecked(name));

  const filteredRows = useMemo(() => {
    let list = searchedRows;
    if (brandOptions.some((name) => brandFilter[name] === false)) {
      list = list.filter((row) => brandFilter[row.brand] !== false);
    }
    if (currentGroupOptions.some((name) => currentGroupFilter[name] === false)) {
      list = list.filter((row) => currentGroupFilter[row.currentGroup] !== false);
    }
    return list;
  }, [searchedRows, brandFilter, brandOptions, currentGroupFilter, currentGroupOptions]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const pagedRows = filteredRows.slice(startIndex, startIndex + rowsPerPage);

  const handleExport = useCallback(() => {
    const headers = ['Brand', 'Agent', 'Balance Inside', 'Company Money', 'Discrepancy', 'SDP VS Balance', 'Current Group', 'Correct Group', 'Remarks'];

    const data = filteredRows.map((row) => [
      row.brand,
      row.shopName,
      row.balanceInside,
      row.companyBalance,
      row.discrepancy,
      row.sdpVsBalance > 0 ? Math.abs(row.sdpVsBalance) : undefined,
      row.currentGroup,
      row.correctGroup,
      row.remarks,
    ]);

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Transfer Queue');

    XLSX.writeFile(workbook, 'transfer-queue.xlsx');
  }, [filteredRows]);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  return (
    <div className="min-h-screen overflow-y-hidden bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white">
      <header className="border-b border-[#e5e5e7] bg-white px-4 py-2 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] md:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Transfer Queue</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 rounded-xl border border-[#e5e5e7] px-2 py-1.5 text-[11px] text-[#6b7280] dark:border-[#3a3a3d] dark:text-[#a0a0a0]">
              {loading ? (
                <div className="h-3 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700 md:w-48" />
              ) : (
                <>
                  <Search size={12} />
                  <input
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    className="w-32 bg-transparent outline-none md:w-48"
                    placeholder="Search"
                  />
                </>
              )}
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
        {error && (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-200 px-5 py-4 text-sm text-rose-600 dark:border-rose-900/60 dark:text-rose-300">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {!error && (
          <div className="overflow-hidden rounded-xl border border-[#e5e5e7] bg-white dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
            <div className="flex items-center justify-between gap-3 border-b border-[#e5e5e7] px-2 py-1.5 dark:border-[#3a3a3d]">
              {loading ? (
                <div className="h-2.5 w-24 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse" />
              ) : (
                <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">For Transfer: {filteredRows.length.toLocaleString('en-PH')}</span>
              )}
              <div className="flex items-center gap-3">
              {loading ? (
                <div className="h-2.5 w-32 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse" />
              ) : (
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
              )}
              {!loading && (
                <button
                  type="button"
                  onClick={handleExport}
                  title="Export to Excel"
                  className="flex items-center justify-center rounded-xl border border-[#e5e5e7] p-1.5 text-[#6b7280] transition hover:bg-slate-50 dark:border-[#3a3a3d] dark:text-[#a0a0a0] dark:hover:bg-white/10"
                >
                  <Download size={14} />
                </button>
              )}
              </div>
            </div>
            <div className="max-h-[calc(100vh-140px)] overflow-y-auto overflow-x-scroll">
              <table className="w-full table-auto text-xs">
                <thead className="sticky top-0 z-[50] bg-white dark:bg-[#2a2a2d]">
                  <tr>
                    <th className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 text-center whitespace-nowrap px-4 py-3">
                      {loading ? (
                        <div className="mx-auto h-2.5 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      ) : (
                        <div className="relative flex items-center justify-center gap-1">
                          <span>Brand</span>
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
                      )}
                    </th>
                    {['Agent', 'Company Money', 'Balance Inside', 'Discrepancy', 'SDP VS Balance'].map((label) => (
                      <th key={label} className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 text-center whitespace-nowrap px-4 py-3">
                        {loading ? (
                          <div className="mx-auto h-2.5 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        ) : (
                          label
                        )}
                      </th>
                    ))}
                    <th className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 text-center whitespace-nowrap px-4 py-3">
                      {loading ? (
                        <div className="mx-auto h-2.5 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      ) : (
                        <div className="relative flex items-center justify-center gap-1">
                          <span>Current Group</span>
                          <button
                            type="button"
                            ref={currentGroupButtonRef}
                            onClick={(event) => {
                              event.stopPropagation();
                              const rect = currentGroupButtonRef.current?.getBoundingClientRect();
                              if (rect) {
                                const dropdownWidth = 176;
                                const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                                setCurrentGroupMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                              }
                              setCurrentGroupMenuOpen((current) => !current);
                            }}
                            className={`flex items-center justify-center rounded-full p-1 transition ${anyCurrentGroupUnchecked ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/30 dark:text-indigo-200' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                          >
                            <Filter size={12} className={anyCurrentGroupUnchecked ? 'opacity-100' : 'opacity-70'} />
                          </button>
                          {currentGroupMenuOpen && typeof document !== 'undefined' && createPortal(
                            <div
                              ref={currentGroupDropdownRef}
                              style={{ position: 'fixed', top: currentGroupMenuPos.top, left: currentGroupMenuPos.left }}
                              className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <div className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Filter</div>
                              <div className="max-h-56 overflow-y-auto">
                                <label className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                  <input
                                    type="checkbox"
                                    checked={allCurrentGroupsChecked}
                                    onChange={() => {
                                      const nextValue = !allCurrentGroupsChecked;
                                      setCurrentGroupFilter(Object.fromEntries(currentGroupOptions.map((name) => [name, nextValue])));
                                    }}
                                  />
                                  <span>All</span>
                                </label>
                                {currentGroupOptions.map((group) => (
                                  <label key={group} className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={isCurrentGroupChecked(group)}
                                      onChange={() => {
                                        setCurrentGroupFilter((current) => ({ ...current, [group]: !isCurrentGroupChecked(group) }));
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
                      )}
                    </th>
                    {['Correct Group', 'Remarks'].map((label) => (
                      <th key={label} className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 text-center whitespace-nowrap px-4 py-3">
                        {loading ? (
                          <div className="mx-auto h-2.5 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        ) : (
                          label
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 12 }).map((_, rowIndex) => (
                      <tr key={rowIndex} className="bg-white dark:bg-[#2a2a2d]">
                        <td colSpan={9} className="px-4 py-2">
                          <div className="h-2.5 w-full animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </td>
                      </tr>
                    ))
                  ) : pagedRows.length > 0 ? pagedRows.map((row) => (
                    <tr key={row.key} className="bg-white dark:bg-[#2a2a2d]">
                      <td className="text-[9px] text-center px-4 py-2 text-slate-700 dark:text-slate-300">{row.brand}</td>
                      <td className="text-[9px] text-center px-4 py-2 text-slate-700 dark:text-slate-300">{row.shopName}</td>
                      <td className={`text-[9px] text-center px-4 py-2 ${row.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        {displayNum(row.companyBalance)}
                      </td>
                      <td className={`text-[9px] text-center px-4 py-2 ${row.balanceInside < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        {displayNum(row.balanceInside)}
                      </td>
                      <td className={`text-[9px] text-center px-4 py-2 ${row.discrepancy < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        {displayNum(row.discrepancy)}
                      </td>
                      <td className="text-[9px] text-center px-4 py-2 text-slate-700 dark:text-slate-300">
                        {row.sdpVsBalance > 0 ? displayNum(Math.abs(row.sdpVsBalance)) : '−'}
                      </td>
                      <td className="text-[9px] text-center px-4 py-2 text-slate-700 dark:text-slate-300">{row.currentGroup}</td>
                      <td className="text-[9px] text-center px-4 py-2 text-slate-700 dark:text-slate-300">{row.correctGroup}</td>
                      <td className="text-[9px] text-center px-4 py-2 text-slate-500">{row.remarks}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={9} className="px-3 py-8 text-center text-[9px] text-[#6b7280] dark:text-[#a0a0a0]">
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
