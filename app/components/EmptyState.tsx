import type { ReactNode } from 'react';
import { SearchX, type LucideIcon } from 'lucide-react';

type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description: string;
  // A single composed action (button/link), not a label+onClick pair —
  // different empty-state reasons want different actions ("Clear Filters"
  // vs "Refresh" vs something else entirely on a future page), so the
  // caller decides what that action is rather than this component
  // hardcoding a fixed set of variants.
  action?: ReactNode;
};

// Generic table-body empty state — icon, title, description, optional
// action, nothing else. Positioned in the 25-35%-from-top band (pt-[12%])
// rather than dead-centered, per the original spec this was built against.
// Settlement is the first consumer; the two-variant "search vs no data"
// branching that used to live here now lives in the caller, since which
// copy/action applies is page-specific logic, not layout.
export default function EmptyState({ icon: Icon = SearchX, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center px-6 pb-6 pt-[12%] text-center dt-fade-in">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#F8FAFC] dark:bg-white/5 sm:h-16 sm:w-16">
        <Icon size={40} className="text-[#94A3B8] opacity-70 sm:hidden" />
        <Icon size={48} className="hidden text-[#94A3B8] opacity-70 sm:block" />
      </div>
      <p className="mt-5 text-[18px] font-semibold text-[#111827] dark:text-[#E5E7EB]">{title}</p>
      <p className="mt-2 max-w-[320px] text-[14px] font-normal text-[#64748B]">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
