'use client';

import { useCallback, useEffect, useState } from 'react';
import { SlidersHorizontal, Check, X, Loader2 } from 'lucide-react';
import PageHeader from '../../components/PageHeader';
import ConnectionErrorState from '../../components/ConnectionErrorState';
import { classifyFetchError, type ClassifiedError, assertAllOk } from '../../lib/errors';

// Mirrors app/lib/transferQueueSettings.ts's own types — not imported
// directly since that file pulls in `googleapis` (Node-only, breaks the
// client bundle); same "fetch via API route, define a matching local type"
// convention every other write-capable feature in this app follows (e.g.
// app/wallet-status/page.tsx re-declaring app/lib/walletStatus.ts's types).
// Plain-word form, not symbols — per explicit instruction, so staff reading
// either the dropdown or the raw sheet cell understand it immediately.
type Operator = 'Greater Than' | 'Greater Than or Equal' | 'Less Than' | 'Less Than or Equal' | 'Between' | 'Equal';
type RuleSection = 'cashout_day' | 'cashout_extended' | 'cashout_247' | 'sendmoney_247' | 'sendmoney_bd';

type RuleRow = {
  section: RuleSection;
  metric: string;
  operator: Operator;
  value1: number;
  value2: number | null;
  queueResult: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
};

type BundleField = {
  field: string;
  value: string;
  updatedBy: string;
  updatedAt: string;
};

const OPERATORS: Operator[] = ['Greater Than', 'Greater Than or Equal', 'Less Than', 'Less Than or Equal', 'Between', 'Equal'];

const SECTION_META: Record<RuleSection, { emoji: string; title: string; description: string }> = {
  cashout_day: {
    emoji: '☀️',
    title: 'Day Configuration',
    description: 'Cashout — Day variant, used by most brands (B1, B2, B4, B5, J1, K1, M2, T1).',
  },
  cashout_extended: {
    emoji: '🌇',
    title: 'Extended Configuration',
    description: 'Cashout — M1’s own Day ruleset (M1 uses a fuller 4-rule shape instead of the standard 2-rule Day template).',
  },
  cashout_247: {
    emoji: '🌙',
    title: '24/7 Configuration',
    description: 'Cashout — 24/7 variant, applies to all 10 brands.',
  },
  sendmoney_247: {
    emoji: '🌙',
    title: '24/7 Configuration',
    description: 'Send Money — every brand except SH, exactly two possible outcomes.',
  },
  sendmoney_bd: {
    emoji: '🏷️',
    title: 'BD Limit',
    description: 'Send Money — replaces the old blanket "BD"-wallet-name exclusion with an actual configurable limit.',
  },
};

// "July 22, 2026 10:42 AM" — same Manila-anchored format convention as
// app/wallet-status/page.tsx's formatRemarkTimestamp.
function formatTimestamp(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')} ${get('day')}, ${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;
}

function rowIsDirty(saved: RuleRow, draft: RuleRow): boolean {
  return saved.operator !== draft.operator || saved.value1 !== draft.value1 || saved.value2 !== draft.value2 || saved.queueResult !== draft.queueResult || saved.enabled !== draft.enabled;
}

const INPUT_CLASS = 'h-8 w-full rounded-md border border-border bg-white px-2 text-[12px] text-foreground outline-none focus:border-[#2563EB] dark:bg-[#1c1c1e]';

function RuleSectionCard({
  section,
  rules,
  drafts,
  saving,
  onChangeRow,
  onSave,
  onCancel,
}: {
  section: RuleSection;
  rules: RuleRow[];
  drafts: RuleRow[];
  saving: boolean;
  onChangeRow: (index: number, patch: Partial<RuleRow>) => void;
  onSave: (section: RuleSection) => void;
  onCancel: (section: RuleSection) => void;
}) {
  const meta = SECTION_META[section];
  const indices = drafts.map((_, i) => i).filter((i) => drafts[i].section === section);
  const hasChanges = indices.some((i) => rowIsDirty(rules[i], drafts[i]));

  return (
    <div className="mb-6 rounded-xl border border-border bg-white p-5 dark:bg-[#2a2a2d]">
      <div className="mb-1 flex items-center gap-2 text-[15px] font-semibold text-foreground">
        <span>{meta.emoji}</span> {meta.title}
      </div>
      <p className="mb-4 text-[12px] text-muted-foreground">{meta.description}</p>

      <div className="space-y-2.5">
        {indices.map((i) => {
          const d = drafts[i];
          const saved = rules[i];
          const isBetween = d.operator === 'Between';
          return (
            <div key={i} className="overflow-hidden rounded-lg border border-border p-3">
              <div className="mb-3 flex flex-wrap items-center justify-end gap-2.5 pr-1">
                <button
                  type="button"
                  onClick={() => onChangeRow(i, { enabled: !d.enabled })}
                  className={`relative h-[30px] w-[52px] shrink-0 cursor-pointer rounded-full border transition-colors duration-200 ease hover:brightness-95 ${d.enabled ? 'border-[#5B5CEB] bg-[#5B5CEB]' : 'border-[#D1D5DB] bg-[#E5E7EB] dark:border-[#4a4a4d] dark:bg-[#3a3a3d]'}`}
                >
                  {/* Base position is an explicit left-[3px], never `auto` —
                      translate is only the incremental shift (22px = track
                      52 − thumb 24 − 3px inset on each side), so the thumb's
                      final position is provably always inside the track
                      regardless of the button's own layout context (the
                      previous `auto`-based left let the browser's static
                      positioning push the thumb outside the track). */}
                  <span
                    className={`absolute left-[3px] top-[3px] h-6 w-6 rounded-full bg-white transition-transform duration-200 ease ${d.enabled ? 'translate-x-[22px] shadow-[0_2px_6px_rgba(0,0,0,0.15)]' : 'translate-x-0'}`}
                  />
                </button>
              </div>
              <div className={`grid grid-cols-12 items-center gap-2 transition-opacity duration-150 ease-out ${d.enabled ? '' : 'opacity-50'}`}>
                <div className="col-span-3 text-[12px] font-medium text-foreground">{d.metric}</div>
                <select
                  value={d.operator}
                  onChange={(e) => onChangeRow(i, { operator: e.target.value as Operator })}
                  disabled={!d.enabled}
                  className={`${INPUT_CLASS} col-span-2 disabled:cursor-not-allowed`}
                >
                  {OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
                </select>
                <input
                  type="number"
                  value={d.value1}
                  onChange={(e) => onChangeRow(i, { value1: Number(e.target.value) })}
                  disabled={!d.enabled}
                  className={`${INPUT_CLASS} col-span-2 tabular-nums disabled:cursor-not-allowed`}
                />
                {isBetween && (
                  <>
                    <span className="col-span-1 text-center text-[11px] text-muted-foreground">and</span>
                    <input
                      type="number"
                      value={d.value2 ?? 0}
                      onChange={(e) => onChangeRow(i, { value2: Number(e.target.value) })}
                      disabled={!d.enabled}
                      className={`${INPUT_CLASS} col-span-2 tabular-nums disabled:cursor-not-allowed`}
                    />
                  </>
                )}
                <input
                  type="text"
                  value={d.queueResult}
                  onChange={(e) => onChangeRow(i, { queueResult: e.target.value })}
                  placeholder="Queue result…"
                  disabled={!d.enabled}
                  className={`${INPUT_CLASS} ${isBetween ? 'col-span-2' : 'col-span-5'} disabled:cursor-not-allowed`}
                />
              </div>
              {/* Per-row (not just per-section) so it's clear exactly which
                  rule was last touched, per explicit instruction. */}
              <p className="mt-2 text-[10px] text-muted-foreground">
                {saved.updatedAt ? `Last updated ${formatTimestamp(saved.updatedAt)} by ${saved.updatedBy}` : 'Never updated'}
              </p>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-end">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onCancel(section)}
            disabled={!hasChanges || saving}
            className="flex h-8 items-center gap-1 rounded-[8px] border border-[#E5E7EB] bg-white px-2.5 text-[12px] font-medium text-slate-500 transition-colors duration-150 ease-out hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:border-rose-900/60 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
          >
            <X size={13} /> Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(section)}
            disabled={!hasChanges || saving}
            className="flex h-8 items-center gap-1 rounded-[8px] bg-[#5B5CEB] px-2.5 text-[12px] font-semibold text-white transition-opacity duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

function BundleSectionCard({
  saved,
  drafts,
  saving,
  onChangeField,
  onSave,
  onCancel,
}: {
  saved: BundleField[];
  drafts: BundleField[];
  saving: boolean;
  onChangeField: (index: number, value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const hasChanges = drafts.some((d, i) => d.value !== saved[i]?.value);

  return (
    <div className="mb-6 rounded-xl border border-border bg-white p-5 dark:bg-[#2a2a2d]">
      <div className="mb-1 flex items-center gap-2 text-[15px] font-semibold text-foreground">
        <span>📦</span> Bundle Configuration
      </div>
      <p className="mb-4 text-[12px] text-muted-foreground">Future configurable values may be added here.</p>

      <div className="space-y-2.5">
        {drafts.map((f, i) => {
          const isToggle = f.field === 'Bundle Enabled' || f.field === 'Auto Grouping';
          const savedField = saved[i];
          return (
            <div key={f.field} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] font-medium text-foreground">{f.field}</span>
                {isToggle ? (
                  <button
                    type="button"
                    onClick={() => onChangeField(i, f.value === 'true' ? 'false' : 'true')}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150 ease-out ${f.value === 'true' ? 'bg-[#5B5CEB]' : 'bg-muted'}`}
                  >
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-150 ease-out ${f.value === 'true' ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                  </button>
                ) : (
                  <input
                    type="text"
                    value={f.value}
                    onChange={(e) => onChangeField(i, e.target.value)}
                    className={`${INPUT_CLASS} max-w-[220px]`}
                  />
                )}
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                {savedField?.updatedAt ? `Last updated ${formatTimestamp(savedField.updatedAt)} by ${savedField.updatedBy}` : 'Never updated'}
              </p>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-end">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={!hasChanges || saving}
            className="flex h-8 items-center gap-1 rounded-[8px] border border-[#E5E7EB] bg-white px-2.5 text-[12px] font-medium text-slate-500 transition-colors duration-150 ease-out hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:border-[#3a3a3d] dark:bg-[#2a2a2d] dark:text-[#9CA3AF] dark:hover:border-rose-900/60 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
          >
            <X size={13} /> Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!hasChanges || saving}
            className="flex h-8 items-center gap-1 rounded-[8px] bg-[#5B5CEB] px-2.5 text-[12px] font-semibold text-white transition-opacity duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TransferQueueSettingsPage() {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [drafts, setDrafts] = useState<RuleRow[]>([]);
  const [bundle, setBundle] = useState<BundleField[]>([]);
  const [bundleDraft, setBundleDraft] = useState<BundleField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [savingSection, setSavingSection] = useState<RuleSection | 'bundle' | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/configurations/transfer-queue-settings?t=${Date.now()}`);
      await assertAllOk([res]);
      const data: { rules: RuleRow[]; bundle: BundleField[] } = await res.json();
      setRules(data.rules);
      setDrafts(data.rules);
      setBundle(data.bundle);
      setBundleDraft(data.bundle);
    } catch (err) {
      setError(classifyFetchError(err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const updateDraftRow = useCallback((index: number, patch: Partial<RuleRow>) => {
    setDrafts((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }, []);

  const cancelSection = useCallback((section: RuleSection) => {
    setDrafts((current) => current.map((r, i) => (rules[i].section === section ? rules[i] : r)));
  }, [rules]);

  // Every row's Save only ever POSTs the rows that actually changed within
  // that section — Cancel just re-renders from the already-fetched saved
  // state, no refetch needed (single-admin editing, nothing else could
  // have changed it meanwhile).
  const saveSection = useCallback(async (section: RuleSection) => {
    const dirtyIndices = drafts
      .map((_, i) => i)
      .filter((i) => rules[i].section === section && rowIsDirty(rules[i], drafts[i]));
    if (dirtyIndices.length === 0) return;

    setSavingSection(section);
    try {
      const results = await Promise.all(dirtyIndices.map(async (i) => {
        const d = drafts[i];
        const res = await fetch('/api/configurations/transfer-queue-settings/update-rule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: i, operator: d.operator, value1: d.value1, value2: d.value2, queueResult: d.queueResult, enabled: d.enabled }),
        });
        if (!res.ok) throw new Error('Save failed');
        const data: { updatedBy: string; updatedAt: string } = await res.json();
        return { i, updatedBy: data.updatedBy, updatedAt: data.updatedAt };
      }));

      setRules((current) => current.map((r, i) => {
        const match = results.find((x) => x.i === i);
        return match ? { ...drafts[i], updatedBy: match.updatedBy, updatedAt: match.updatedAt } : r;
      }));
      setDrafts((current) => current.map((r, i) => {
        const match = results.find((x) => x.i === i);
        return match ? { ...r, updatedBy: match.updatedBy, updatedAt: match.updatedAt } : r;
      }));
      setToast('Configuration saved successfully.');
    } catch {
      await fetchData();
    } finally {
      setSavingSection(null);
    }
  }, [rules, drafts, fetchData]);

  const updateBundleField = useCallback((index: number, value: string) => {
    setBundleDraft((current) => current.map((f, i) => (i === index ? { ...f, value } : f)));
  }, []);

  const cancelBundle = useCallback(() => {
    setBundleDraft(bundle);
  }, [bundle]);

  const saveBundle = useCallback(async () => {
    const dirtyIndices = bundleDraft.map((_, i) => i).filter((i) => bundleDraft[i].value !== bundle[i]?.value);
    if (dirtyIndices.length === 0) return;

    setSavingSection('bundle');
    try {
      const results = await Promise.all(dirtyIndices.map(async (i) => {
        const res = await fetch('/api/configurations/transfer-queue-settings/update-bundle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: i, value: bundleDraft[i].value }),
        });
        if (!res.ok) throw new Error('Save failed');
        const data: { updatedBy: string; updatedAt: string } = await res.json();
        return { i, updatedBy: data.updatedBy, updatedAt: data.updatedAt };
      }));

      setBundle((current) => current.map((f, i) => {
        const match = results.find((x) => x.i === i);
        return match ? { ...bundleDraft[i], updatedBy: match.updatedBy, updatedAt: match.updatedAt } : f;
      }));
      setBundleDraft((current) => current.map((f, i) => {
        const match = results.find((x) => x.i === i);
        return match ? { ...f, updatedBy: match.updatedBy, updatedAt: match.updatedAt } : f;
      }));
      setToast('Configuration saved successfully.');
    } catch {
      await fetchData();
    } finally {
      setSavingSection(null);
    }
  }, [bundle, bundleDraft, fetchData]);

  return (
    <div className="min-h-screen w-full bg-background pb-24 font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      {toast && (
        <div className="fixed right-5 top-5 z-[100] flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3.5 py-2.5 text-[12px] font-medium text-foreground shadow-lg dark:border-emerald-900/50 dark:bg-[#2a2a2d]">
          <Check size={15} className="shrink-0 text-emerald-500" />
          {toast}
        </div>
      )}

      <PageHeader
        icon={SlidersHorizontal}
        title="Transfer Queue Settings"
        description="Configure the threshold that determines when a shop becomes eligible for Transfer Queue. Changes are saved only as configuration."
      />

      <main className="mx-auto max-w-4xl px-4 pb-10 pt-24 md:px-8">
        <div className="mb-6 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/50 dark:bg-amber-500/10">
          <span className="text-[14px] leading-none">🟡</span>
          <div>
            <p className="text-[13px] font-semibold text-amber-800 dark:text-amber-300">Draft Configuration</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-amber-700 dark:text-amber-400/90">
              These values are stored in the backend but are NOT currently used by the live Transfer Queue. The existing Transfer Queue continues using the current production logic until this configuration is approved.
            </p>
          </div>
        </div>

        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && loading && (
          <div className="flex items-center justify-center py-16 text-[13px] text-muted-foreground">
            <Loader2 size={18} className="mr-2 animate-spin" /> Loading configuration…
          </div>
        )}

        {!error && !loading && (
          <>
            <p className="mb-3 text-[13px] font-bold text-foreground">🟣 CASHOUT</p>
            <RuleSectionCard section="cashout_day" rules={rules} drafts={drafts} saving={savingSection === 'cashout_day'} onChangeRow={updateDraftRow} onSave={saveSection} onCancel={cancelSection} />
            <RuleSectionCard section="cashout_extended" rules={rules} drafts={drafts} saving={savingSection === 'cashout_extended'} onChangeRow={updateDraftRow} onSave={saveSection} onCancel={cancelSection} />
            <RuleSectionCard section="cashout_247" rules={rules} drafts={drafts} saving={savingSection === 'cashout_247'} onChangeRow={updateDraftRow} onSave={saveSection} onCancel={cancelSection} />

            <p className="mb-3 mt-8 text-[13px] font-bold text-foreground">🟢 SEND MONEY</p>
            <RuleSectionCard section="sendmoney_247" rules={rules} drafts={drafts} saving={savingSection === 'sendmoney_247'} onChangeRow={updateDraftRow} onSave={saveSection} onCancel={cancelSection} />
            <RuleSectionCard section="sendmoney_bd" rules={rules} drafts={drafts} saving={savingSection === 'sendmoney_bd'} onChangeRow={updateDraftRow} onSave={saveSection} onCancel={cancelSection} />
            <BundleSectionCard saved={bundle} drafts={bundleDraft} saving={savingSection === 'bundle'} onChangeField={updateBundleField} onSave={saveBundle} onCancel={cancelBundle} />
          </>
        )}
      </main>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-amber-200 bg-amber-50 px-4 py-2.5 text-center text-[12px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-300">
        <span className="font-semibold">Configuration Mode Only</span> — Changes made here are saved for future implementation. Current Transfer Queue computation is NOT affected.
      </div>
    </div>
  );
}
