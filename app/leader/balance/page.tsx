'use client';

// Leader app → Balance: every shop under the signed-in leader plus a total
// row. Data from /api/leader/balances (scoped server-side to the session's
// own leader). Fetch on open + manual Refresh only — no auto-refresh.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import LeaderBottomNav, { LEADER_NAV_PADDING } from '@/app/components/LeaderBottomNav';
import { formatAmount } from '@/app/lib/leaderRequests';

type Row = {
  agentId: number;
  agentCode: string;
  product: 'cashout' | 'sendmoney';
  companyBalance: number;
  openingBalance: number;
  totalDp: number;
  totalWd: number;
  totalTopUp: number;
  totalSettlement: number;
};
type Totals = Omit<Row, 'agentId' | 'agentCode' | 'product'>;
type Data = { rows: Row[]; total: Totals; shopCount: number };

const PAGE_SIZE = 50;
const PRODUCT_LABEL: Record<Row['product'], string> = { cashout: 'Cashout', sendmoney: 'Send Money' };
const PRODUCT_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'cashout', label: 'Cashout' },
  { value: 'sendmoney', label: 'Send Money' },
] as const;

const fmt = (n: number) => (n === 0 ? '−' : formatAmount(n));

function Metric({ label, value, className = '' }: { label: string; value: number; className?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className={`break-words text-[13.5px] font-semibold tabular-nums ${className}`}>{fmt(value)}</p>
    </div>
  );
}

function Breakdown({ r }: { r: Totals }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-3">
      <Metric label="Opening" value={r.openingBalance} />
      <Metric label="Total DP" value={r.totalDp} className="text-emerald-600 dark:text-emerald-400" />
      <Metric label="Total WD" value={r.totalWd} className="text-rose-600 dark:text-rose-400" />
      <Metric label="Top Up" value={r.totalTopUp} className="text-teal-600 dark:text-teal-400" />
      <Metric label="Settlement" value={r.totalSettlement} className="text-orange-600 dark:text-orange-400" />
    </div>
  );
}

export default function LeaderBalancePage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [product, setProduct] = useState<(typeof PRODUCT_FILTERS)[number]['value']>('all');
  // "Show more" count, reset whenever the search/filter changes.
  const filterKey = `${search}|${product}`;
  const [shown, setShown] = useState({ key: filterKey, n: PAGE_SIZE });
  const limit = shown.key === filterKey ? shown.n : PAGE_SIZE;

  const fetchBalances = useCallback(
    () =>
      fetch('/api/leader/balances', { cache: 'no-store' })
        .then((res) => (res.ok ? (res.json() as Promise<Data>) : Promise.reject()))
        .then((d) => { setData(d); setError(null); })
        .catch(() => setError('Could not load balances. Check your connection and tap Refresh.')),
    []
  );

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  function load() {
    setLoading(true);
    fetchBalances().finally(() => setLoading(false));
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => (product === 'all' || r.product === product) && (!q || r.agentCode.toLowerCase().includes(q)));
  }, [data, search, product]);

  return (
    <div className="h-dvh w-full overflow-y-auto bg-background font-[Inter,sans-serif] text-foreground">
      <div className={`mx-auto w-full max-w-2xl px-4 py-6 sm:px-8 ${LEADER_NAV_PADDING}`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Balance</h1>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            aria-label="Refresh"
            className="flex h-11 items-center gap-1.5 rounded-[10px] border border-border bg-card px-3.5 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-[9px] border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12.5px] font-medium text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">{error}</div>
        )}

        {!data && !error && (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {data && (
          <>
            <section aria-label="Total across all shops" className="mb-4 rounded-[14px] border border-border bg-card p-4">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <p className="text-[12px] font-semibold text-muted-foreground">Total · {data.shopCount} shop{data.shopCount === 1 ? '' : 's'}</p>
              </div>
              <p className="text-[11px] font-medium text-muted-foreground">Company Balance</p>
              <p className={`mb-3 text-[28px] font-bold leading-tight tabular-nums ${data.total.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                {fmt(data.total.companyBalance)}
              </p>
              <Breakdown r={data.total} />
            </section>

            <div className="relative mb-3">
              <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <label htmlFor="shop-search" className="sr-only">Search shops</label>
              <input
                id="shop-search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search shop"
                autoComplete="off"
                className="h-12 w-full rounded-[12px] border border-border bg-card pl-10 pr-4 text-[15px] text-foreground placeholder:text-muted-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
              />
            </div>

            <div className="mb-4 flex gap-2">
              {PRODUCT_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setProduct(f.value)}
                  aria-pressed={product === f.value}
                  className={`h-10 rounded-full px-4 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] ${
                    product === f.value ? 'bg-[color:var(--ui-accent-soft)] text-[color:var(--ui-accent)]' : 'border border-border bg-card text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-xl border border-border bg-card px-6 py-12 text-center">
                <p className="text-[13.5px] font-bold">{data.rows.length === 0 ? 'No shops yet' : 'No matching shops'}</p>
                <p className="mt-1 text-[12px] text-muted-foreground">{data.rows.length === 0 ? 'Shops linked to your account will show here.' : 'Try a different search or filter.'}</p>
              </div>
            ) : (
              <ul className="space-y-3">
                {filtered.slice(0, limit).map((r) => (
                  <li key={`${r.product}-${r.agentId}`} className="rounded-[14px] border border-border bg-card p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-bold">{r.agentCode}</p>
                        <p className="text-[11.5px] text-muted-foreground">{PRODUCT_LABEL[r.product]}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[11px] font-medium text-muted-foreground">Company Balance</p>
                        <p className={`text-[17px] font-bold tabular-nums ${r.companyBalance < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>{fmt(r.companyBalance)}</p>
                      </div>
                    </div>
                    <Breakdown r={r} />
                  </li>
                ))}
              </ul>
            )}

            {filtered.length > limit && (
              <button
                type="button"
                onClick={() => setShown({ key: filterKey, n: limit + PAGE_SIZE })}
                className="mt-4 h-12 w-full rounded-[12px] border border-border bg-card text-[14px] font-semibold text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
              >
                Show more ({filtered.length - limit} left)
              </button>
            )}
          </>
        )}
      </div>
      <LeaderBottomNav />
    </div>
  );
}
