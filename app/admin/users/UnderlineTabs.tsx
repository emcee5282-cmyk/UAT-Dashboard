'use client';

import type { PillTabDef } from '@/app/components/PillTabs';

// Users | Roles switcher for this page only — underline style (active:
// accent text + 2px underline; idle: muted text, no border/background).
// Same props and mb-4 as the shared PillTabs, so it drops in where that was.
export default function UnderlineTabs<K extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: PillTabDef<K>[];
  active: K;
  onSelect: (key: K) => void;
}) {
  return (
    <div role="tablist" className="mb-4 flex items-center gap-6">
      {tabs.map((t) => {
        const selected = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(t.key)}
            className={`relative flex h-8 items-center text-[13px] transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:rounded-full after:content-[''] ${
              selected
                ? 'font-semibold text-[var(--ui-accent)] after:bg-[var(--ui-accent)]'
                : 'font-medium text-muted-foreground after:bg-transparent hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
