import EmptyProductState from '@/app/components/EmptyProductState';
import { getSendMoneyRoute } from '@/app/lib/sendMoneyRoutes';

// Shell + empty state only — the real dashboard layout will be designed
// separately once the Send Money data source is connected.
export default function SendMoneyDashboardPage() {
  const route = getSendMoneyRoute('/sendmoney');

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-white/95 py-0 pl-14 pr-4 backdrop-blur-sm dark:bg-[#0d1117]/95 md:px-8">
        <div className="flex h-12 items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-4 w-[3px] rounded-full bg-[color:var(--product-accent)]" />
            <h1 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">{route.title}</h1>
          </div>
          <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
            <span className="text-[9px] font-medium text-muted-foreground">Not connected</span>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden px-6 pt-4 pb-6">
        <div className="flex-1 flex flex-col min-h-0 bg-white rounded-xl border border-border overflow-hidden dark:bg-[#2a2a2d]">
          <EmptyProductState
            title="No data source connected yet"
            message="Send Money's dashboard will be built out once its data source is connected."
          />
        </div>
      </main>
    </div>
  );
}
