import { Filter, RefreshCw, Search } from 'lucide-react';

const columnLabels = [
  'Brand', 'Leader', 'Wallet Name', 'SDP', 'Opening', 'Total DP', 'Total WD',
  'Top Up', 'Settlement', 'Company Balance', 'Balance Inside',
  'Agent Withdrawal', 'SDP VS Balance', 'Wallet Status',
];

export default function BalancesMockup() {
  return (
    <div className="min-h-screen overflow-y-hidden bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white">
      <header className="border-b border-[#e5e5e7] bg-white px-4 py-2 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] md:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Balances</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 rounded-xl border border-[#e5e5e7] px-2 py-1.5 text-[11px] text-[#6b7280] dark:border-[#3a3a3d] dark:text-[#a0a0a0]">
              <Search size={12} />
              <input
                disabled
                className="w-32 bg-transparent outline-none md:w-48"
                placeholder="Search"
              />
            </label>
            <span className="flex items-center gap-1.5 text-[11px] text-[#6b7280] dark:text-[#a0a0a0]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              —
            </span>
            <button
              type="button"
              disabled
              className="flex items-center gap-2 rounded-xl border border-[#e5e5e7] px-2 py-1.5 text-[11px] font-medium text-[#6b7280] dark:border-[#3a3a3d] dark:text-[#a0a0a0]"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="relative space-y-2 p-3">
        <div className="overflow-hidden rounded-xl border border-[#e5e5e7] bg-white dark:border-[#3a3a3d] dark:bg-[#2a2a2d]">
          <div className="flex items-center justify-between gap-3 border-b border-[#e5e5e7] px-2 py-1.5 dark:border-[#3a3a3d]">
            <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Total Accounts: 0</span>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 rounded-xl border border-[#e5e5e7] px-2 py-0.5 dark:border-[#3a3a3d]">
                <span className="rounded-xl px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 opacity-40 dark:text-slate-300">Previous</span>
                <span className="text-[10px] text-slate-500 dark:text-slate-400">Page 1 of 1</span>
                <span className="rounded-xl px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 opacity-40 dark:text-slate-300">Next</span>
              </div>
              <button
                type="button"
                disabled
                className="flex items-center justify-center rounded-xl border border-[#e5e5e7] p-1.5 text-[#6b7280] dark:border-[#3a3a3d] dark:text-[#a0a0a0]"
              >
                <Filter size={14} />
              </button>
            </div>
          </div>
          <div className="max-h-[calc(100vh-140px)] overflow-y-auto overflow-x-scroll">
            <table className="w-full table-auto text-xs">
              <thead className="sticky top-0 z-[50] bg-white dark:bg-[#2a2a2d]">
                <tr className="text-center text-[10px] font-semibold uppercase text-slate-500 dark:text-slate-400">
                  {columnLabels.map((label) => (
                    <th key={label} className="whitespace-nowrap border-b border-slate-200 px-4 py-3 text-center dark:border-slate-700">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={columnLabels.length} className="px-3 py-8 text-center text-[9px] text-[#6b7280] dark:text-[#a0a0a0]">
                    No data
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
