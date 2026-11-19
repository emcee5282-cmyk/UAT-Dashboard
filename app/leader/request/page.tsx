'use client';

// Leader app → Request a top-up or settlement for ONE of the leader's own
// shops. Shop list comes from /api/agents/search (leader-scoped, same
// source as Create Ticket); the server re-checks the shop belongs to this
// leader. Creates a ticket (topup_request / settlement_request) via the
// existing POST /api/tickets, so staff handle it in the normal queue.
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Search, X } from 'lucide-react';
import LeaderBottomNav, { LEADER_NAV_PADDING } from '@/app/components/LeaderBottomNav';
import { REQUEST_WALLETS, parseRequestAmount, type RequestTitle } from '@/app/lib/leaderRequests';

type Shop = { id: number; agentCode: string; product: 'cashout' | 'sendmoney' };
const PRODUCT_LABEL: Record<Shop['product'], string> = { cashout: 'Cashout', sendmoney: 'Send Money' };
const MAX_MATCHES = 30;

const TYPES: { value: RequestTitle; label: string }[] = [
  { value: 'topup_request', label: 'Top-up' },
  { value: 'settlement_request', label: 'Settlement' },
];

const labelClass = 'mb-2 block text-[13px] font-semibold text-foreground';
const inputClass =
  'h-12 w-full rounded-[12px] border border-border bg-card px-4 text-[15px] text-foreground placeholder:text-muted-foreground focus:border-[color:var(--ui-accent)] focus:outline-none';

export default function LeaderRequestPage() {
  const router = useRouter();
  const [shops, setShops] = useState<Shop[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [type, setType] = useState<RequestTitle>('topup_request');
  const [shop, setShop] = useState<Shop | null>(null);
  const [shopQuery, setShopQuery] = useState('');
  const [wallet, setWallet] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/agents/search', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setShops(d.agents ?? []))
      .catch(() => setLoadError('Could not load your shops. Check your connection and reopen this page.'));
  }, []);

  const matches = useMemo(() => {
    const q = shopQuery.trim().toLowerCase();
    if (!shops || !q) return [];
    return shops.filter((s) => s.agentCode.toLowerCase().includes(q)).slice(0, MAX_MATCHES);
  }, [shops, shopQuery]);

  const amountValid = parseRequestAmount(amount) !== null;
  const canSubmit = !!shop && !!wallet && amountValid && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !shop) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: type, shopIds: [shop.id], wallet, amount, details: note.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not send the request.');
      router.replace('/leader/requests?sent=1');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the request.');
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-background font-[Inter,sans-serif] text-foreground">
      <form onSubmit={submit} className={`mx-auto w-full max-w-2xl px-4 py-6 sm:px-8 ${LEADER_NAV_PADDING}`} noValidate>
        <h1 className="mb-5 text-2xl font-bold">New request</h1>

        {loadError && (
          <div className="mb-4 rounded-[9px] border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12.5px] font-medium text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">{loadError}</div>
        )}

        <fieldset className="mb-5">
          <legend className={labelClass}>Type</legend>
          <div className="grid grid-cols-2 gap-2 rounded-[12px] border border-border bg-card p-1">
            {TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setType(t.value)}
                aria-pressed={type === t.value}
                className={`h-11 rounded-[9px] text-[14px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] ${
                  type === t.value ? 'bg-[color:var(--ui-accent-soft)] text-[color:var(--ui-accent)]' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="mb-5">
          <label htmlFor="shop" className={labelClass}>Shop</label>
          {shop ? (
            <div className="flex h-12 items-center justify-between gap-3 rounded-[12px] border border-[color:var(--ui-accent)] bg-card pl-4 pr-1.5">
              <span className="min-w-0 truncate text-[15px] font-semibold">
                {shop.agentCode} <span className="text-[12px] font-normal text-muted-foreground">· {PRODUCT_LABEL[shop.product]}</span>
              </span>
              <button
                type="button"
                onClick={() => { setShop(null); setShopQuery(''); }}
                aria-label="Change shop"
                className="flex h-10 w-10 items-center justify-center rounded-[9px] text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
              >
                <X size={18} />
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="shop"
                  type="search"
                  value={shopQuery}
                  onChange={(e) => setShopQuery(e.target.value)}
                  placeholder={shops ? `Search ${shops.length} shops` : 'Loading shops…'}
                  disabled={!shops}
                  autoComplete="off"
                  className={`${inputClass} pl-10`}
                />
              </div>
              {shopQuery.trim() && (
                <ul className="mt-2 max-h-72 divide-y divide-border overflow-y-auto rounded-[12px] border border-border bg-card">
                  {matches.length === 0 && <li className="px-4 py-3 text-[13px] text-muted-foreground">No matching shop</li>}
                  {matches.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setShop(s)}
                        className="flex min-h-12 w-full items-center justify-between px-4 py-2 text-left text-[15px] hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ui-accent)]"
                      >
                        <span className="font-semibold">{s.agentCode}</span>
                        <span className="text-[12px] text-muted-foreground">{PRODUCT_LABEL[s.product]}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <fieldset className="mb-5">
          <legend className={labelClass}>Wallet</legend>
          <div className="grid grid-cols-2 gap-2">
            {REQUEST_WALLETS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWallet(w)}
                aria-pressed={wallet === w}
                className={`flex h-12 items-center justify-center gap-1.5 rounded-[12px] border text-[14px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] ${
                  wallet === w ? 'border-[color:var(--ui-accent)] bg-[color:var(--ui-accent-soft)] text-[color:var(--ui-accent)]' : 'border-border bg-card text-foreground hover:bg-muted'
                }`}
              >
                {wallet === w && <Check size={16} />}
                {w}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="mb-5">
          <label htmlFor="amount" className={labelClass}>Amount</label>
          <input
            id="amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
            placeholder="0"
            autoComplete="off"
            aria-invalid={amount !== '' && !amountValid}
            className={`${inputClass} text-[17px] font-semibold tabular-nums`}
          />
          {amount !== '' && !amountValid && <p className="mt-1.5 text-[12px] font-medium text-rose-600 dark:text-rose-400">Enter an amount greater than 0 (up to 2 decimals).</p>}
        </div>

        <div className="mb-6">
          <label htmlFor="note" className={labelClass}>
            Note <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            rows={3}
            className="w-full rounded-[12px] border border-border bg-card px-4 py-3 text-[15px] text-foreground placeholder:text-muted-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
          />
        </div>

        {error && (
          <div role="alert" className="mb-4 rounded-[9px] border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12.5px] font-medium text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">{error}</div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className={`flex h-14 w-full items-center justify-center gap-2 rounded-[12px] text-[16px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[color:var(--ui-accent)] ${
            canSubmit ? 'cursor-pointer border border-transparent bg-[color:var(--ui-accent)] text-white' : 'cursor-not-allowed border border-border bg-card text-muted-foreground'
          }`}
        >
          {submitting && <Loader2 size={18} className="animate-spin" />}
          Send request
        </button>
      </form>
      <LeaderBottomNav />
    </div>
  );
}
