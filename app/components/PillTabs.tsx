'use client';

// Shared pill/badge tab switcher — bordered white pill idle, tinted-indigo
// pill active. Extracted from Daily Transaction Entry's own hardcoded
// switcher (app/daily-txn-entry/page.tsx) when Pending Balance
// (app/monitoring/pending-balance/page.tsx) needed the identical style,
// per explicit instruction not to duplicate it a second time.
export type PillTabDef<K extends string> = { key: K; label: string };

export default function PillTabs<K extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: PillTabDef<K>[];
  active: K;
  onSelect: (key: K) => void;
}) {
  return (
    <div className="mb-4 flex items-center gap-2">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onSelect(t.key)}
          className={`rounded-[8px] border px-3.5 py-1.5 text-[12px] transition-colors ${
            active === t.key
              ? 'border-[#C7D2FE] bg-[#EEF2FF] font-medium text-[#4F46E5] dark:border-[#3A3F6B] dark:bg-[#1E2140] dark:text-[#A5B4FC]'
              : 'border-[#DEE1E8] bg-white font-normal text-muted-foreground hover:bg-[#F1F2F5] dark:border-[#262B38] dark:bg-[#12151D] dark:hover:bg-[#1A1E29]'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
