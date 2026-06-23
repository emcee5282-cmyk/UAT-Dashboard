'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle } from 'lucide-react';

type OpeningRow = {
  agentName: string;
  openingBal: string;
  sdp: string;
  leader: string;
};

type BalRow = {
  reference: string;
  walletName: string;
  accountStatus: string;
  bank: string;
  channel: string;
  group: string;
  account: string;
  balance: string;
  balanceLimit: string;
  dpLimit: string;
  totalDP: string;
  wdLimit: string;
  totalWD: string;
  updateTime: string;
  login: string;
  status: string;
};

type MergedRow = OpeningRow & BalRow & {
  agentTotalDP: number;
  agentTotalWD: number;
};

function rawVal(val: string): string {
  return (val ?? '').replace(/"/g, '').trim() || '-';
}

function fmtNum(val: string): string {
  const cleaned = (val ?? '').replace(/"/g, '').replace(/,/g, '').trim();
  if (cleaned === '-' || cleaned === '') return '-';
  const num = parseFloat(cleaned);
  if (isNaN(num)) return '-';
  return Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'active') return 'text-emerald-400';
  if (s === 'inactive') return 'text-red-400';
  return 'text-slate-400';
}

function accountStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'dp + wd') return 'text-emerald-400';
  if (s === 'dp only') return 'text-cyan-400';
  if (s === 'wd only') return 'text-amber-400';
  return 'text-slate-400';
}

export default function AgentBalance() {
  const [rows, setRows] = useState<MergedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [spinning, setSpinning] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setSpinning(true);
      setLoading(true);
      setError('');
      setRows([]);

      const [openingRes, balRes] = await Promise.all([
        fetch(`/api/opening?t=${Date.now()}`),
        fetch(`/api/agentbal?t=${Date.now()}`),
      ]);

      if (!openingRes.ok || !balRes.ok) throw new Error('Failed to fetch');

      const openingText = await openingRes.text();
      const balText = await balRes.text();

      // Parse opening sheet
      const openingMap = new Map<string, OpeningRow>();
      openingText.trim().split('\n').slice(1)
        .filter(line => line.trim() !== '')
        .forEach(line => {
          const cols = line.split(',');
          const agentName = rawVal(cols[0]);
          if (agentName && agentName !== 'OLD') {
            openingMap.set(agentName, {
              agentName,
              openingBal: rawVal(cols[1]),
              sdp: rawVal(cols[2]),
              leader: rawVal(cols[3]),
            });
          }
        });

      // Parse agent balance sheet
      const balRows: BalRow[] = balText.trim().split('\n').slice(1)
        .filter(line => line.trim() !== '')
        .map(line => {
          const cols = line.split(',');
          return {
            reference: rawVal(cols[0]),
            walletName: rawVal(cols[1]),
            accountStatus: rawVal(cols[2]),
            bank: rawVal(cols[4]),
            channel: rawVal(cols[5]),
            group: rawVal(cols[6]),
            account: rawVal(cols[7]),
            balance: rawVal(cols[8]),
            balanceLimit: rawVal(cols[9]),
            dpLimit: rawVal(cols[10]),
            totalDP: rawVal(cols[11]),
            wdLimit: rawVal(cols[12]),
            totalWD: rawVal(cols[13]),
            updateTime: rawVal(cols[14]),
            login: rawVal(cols[15]),
            status: rawVal(cols[16]),
          };
        });

      // Compute agent totals
      const agentTotals = new Map<string, { dp: number; wd: number }>();
      balRows.forEach(bal => {
        const name = bal.walletName;
        const dp = parseFloat(bal.totalDP.replace(/,/g, '')) || 0;
        const wd = parseFloat(bal.totalWD.replace(/,/g, '')) || 0;
        const existing = agentTotals.get(name) ?? { dp: 0, wd: 0 };
        agentTotals.set(name, {
          dp: existing.dp + dp,
          wd: existing.wd + wd,
        });
      });

      // Merge
      const merged: MergedRow[] = balRows.map(bal => {
        const opening = openingMap.get(bal.walletName) ?? {
          agentName: bal.walletName,
          openingBal: '-',
          sdp: '-',
          leader: '-',
        };
        const totals = agentTotals.get(bal.walletName) ?? { dp: 0, wd: 0 };
        return {
          ...opening,
          ...bal,
          agentTotalDP: totals.dp,
          agentTotalWD: totals.wd,
        };
      });

      setRows(merged);
      setLastUpdated(new Date().toLocaleTimeString('en-PH'));
    } catch {
      setError('Unable to load data. Check your Google Sheet or network connection.');
    } finally {
      setLoading(false);
      setSpinning(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 600000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const columns = [
    'Leader', 'Agent Name', 'Opening', 'Total DP', 'Total WD',
    'Reference', 'Account Status', 'Bank', 'Channel',
    'Group', 'Account', 'Balance', 'Balance Limit',
    'DP Limit', 'Wallet DP', 'WD Limit', 'Wallet WD',
    'Update Time', 'Login', 'Status'
  ];

  return (
    <div className="min-h-screen text-slate-100 font-sans">

      <div className="sticky top-0 z-20 bg-[#0b0f1a]/80 backdrop-blur-md border-b border-white/[0.06] px-6 py-3.5 flex items-center justify-between">
        <div className="space-y-0.5">
          <span className="text-[10px] font-semibold tracking-[0.15em] uppercase text-indigo-400">Live Dashboard</span>
          <h1 className="text-sm font-bold text-white">Agent Balance</h1>
        </div>
        <div className="flex items-center gap-4">
          {lastUpdated && (
            <div className="hidden sm:flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[11px] text-slate-500">Live · {lastUpdated}</span>
            </div>
          )}
          <button
            onClick={fetchData}
            disabled={spinning}
            className="flex items-center gap-1.5 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 px-3 py-1.5 rounded-lg transition-all disabled:opacity-30"
          >
            <RefreshCw size={11} className={spinning ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      <div className="px-6 py-8 space-y-7">

        {loading && (
          <div className="flex items-center justify-center py-28 gap-3 text-slate-500">
            <Loader2 size={18} className="animate-spin text-indigo-400" />
            <span className="text-sm">Fetching latest data...</span>
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl px-5 py-4 text-sm">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="bg-[#111827]/60 border border-white/[0.07] rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-4 rounded-full bg-indigo-500/60" />
                <h2 className="text-sm font-semibold text-slate-200">Agent Balance</h2>
              </div>
              <span className="text-[11px] text-slate-600 font-mono">{rows.length} accounts</span>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[1800px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-[53px] z-10 bg-[#111827]">
                    <tr className="border-b border-white/[0.05]">
                      {columns.map((col) => (
                        <th key={col} className="px-4 py-3 text-left text-[10px] font-semibold text-slate-600 uppercase tracking-[0.12em] whitespace-nowrap">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors group">
                        <td className="px-4 py-3 text-[11px] font-bold tracking-widest text-indigo-300 uppercase whitespace-nowrap">{row.leader}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-indigo-500/50 group-hover:bg-indigo-400 transition-colors" />
                            <span className="font-semibold text-slate-200 whitespace-nowrap">{row.walletName}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-[12px] text-slate-100 whitespace-nowrap tabular-nums">{fmtNum(row.openingBal)}</td>
                        <td className="px-4 py-3 font-mono text-[12px] text-emerald-400 whitespace-nowrap tabular-nums">{fmtNum(String(row.agentTotalDP))}</td>
                        <td className="px-4 py-3 font-mono text-[12px] text-red-400 whitespace-nowrap tabular-nums">{fmtNum(String(row.agentTotalWD))}</td>
                        <td className="px-4 py-3 font-mono text-[12px] text-slate-400 whitespace-nowrap">{row.reference}</td>
                        <td className={`px-4 py-3 text-[12px] font-medium whitespace-nowrap ${accountStatusColor(row.accountStatus)}`}>{row.accountStatus}</td>
                        <td className="px-4 py-3 text-[12px] text-slate-300 whitespace-nowrap">{row.bank}</td>
                        <td className="px-4 py-3 text-[12px] text-slate-400 whitespace-nowrap">{row.channel}</td>
                        <td className="px-4 py-3 text-[12px] text-slate-400 whitespace-nowrap max-w-[180px] truncate">{row.group}</td>
                        <td className="px-4 py-3 text-[12px] text-slate-400 whitespace-nowrap">{row.account}</td>
                        <td className="px-4 py-3 font-mono text-[12px] text-slate-100 whitespace-nowrap tabular-nums">{fmtNum(row.balance)}</td>
                        <td className="px-4 py-3 font-mono text-[12px] text-slate-400 whitespace-nowrap tabular-nums">{fmtNum(row.balanceLimit)}</td>
                        <td className="px-4 py-3 font-mono text-[12px] text-slate-400 whitespace-nowrap tabular-nums">{fmtNum(row.dpLimit)}</td>
                        <td className="px-4 py-3 font-mono text-[12px] text-emerald-400 whitespace-nowrap tabular-nums">{fmtNum(row.totalDP)}</td>
                        <td className="px-4 py-3 font-mono text-[12px] text-slate-400 whitespace-nowrap tabular-nums">{fmtNum(row.wdLimit)}</td>
                        <td className="px-4 py-3 font-mono text-[12px] text-red-400 whitespace-nowrap tabular-nums">{fmtNum(row.totalWD)}</td>
                        <td className="px-4 py-3 text-[12px] text-slate-500 whitespace-nowrap">{row.updateTime}</td>
                        <td className="px-4 py-3 text-[12px] text-slate-400 whitespace-nowrap">{row.login}</td>
                        <td className={`px-4 py-3 text-[12px] font-medium whitespace-nowrap ${statusColor(row.status)}`}>{row.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        <p className="text-center text-[11px] text-slate-700 pb-2 tracking-wide">
          Powered by AFKenta Solution ®
        </p>
      </div>
    </div>
  );
}