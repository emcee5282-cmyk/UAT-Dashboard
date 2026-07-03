import { Columns3, Download, Filter, Search } from 'lucide-react';
import EmptyProductState from './EmptyProductState';

type SendMoneyPageShellProps = {
  title: string;
  itemLabel: string;
};

export default function SendMoneyPageShell({ title, itemLabel }: SendMoneyPageShellProps) {
  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-white/95 py-0 pl-14 pr-4 backdrop-blur-sm dark:bg-[#0d1117]/95 md:px-8">
        <div className="flex h-12 items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-4 w-[3px] rounded-full bg-[color:var(--product-accent)]" />
            <h1 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">{title}</h1>
          </div>
          <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
            <span className="text-[9px] font-medium text-muted-foreground">Not connected</span>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden px-6 pt-4 pb-6">
        <div className="flex-1 flex flex-col min-h-0 bg-white rounded-xl border border-border overflow-hidden dark:bg-[#2a2a2d]">
          <div className="shrink-0 px-3 py-2 border-b border-border bg-muted/20 flex flex-wrap items-center justify-between gap-2">
            <div className="flex w-full min-w-[140px] flex-1 items-center gap-2 rounded-lg border border-border bg-white px-3 py-1.5 opacity-50 dark:bg-[#2a2a2d] sm:w-52 sm:flex-none">
              <Search size={13} className="shrink-0 text-muted-foreground" />
              <input
                disabled
                className="flex-1 cursor-not-allowed bg-transparent text-[10px] text-foreground placeholder:text-muted-foreground outline-none border-none"
                placeholder={`Search ${itemLabel}...`}
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled
                className="flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[10px] font-medium text-muted-foreground opacity-50"
              >
                <Filter size={14} />
                Filter
              </button>
              <button
                type="button"
                disabled
                title="Columns"
                className="flex cursor-not-allowed items-center justify-center rounded-lg border border-border p-1.5 text-muted-foreground opacity-50"
              >
                <Columns3 size={13} />
              </button>
              <button
                type="button"
                disabled
                title="Export"
                className="flex cursor-not-allowed items-center justify-center rounded-lg border border-border p-1.5 text-muted-foreground opacity-50"
              >
                <Download size={13} />
              </button>
            </div>
          </div>

          <EmptyProductState message={`Send Money ${itemLabel} will appear here once connected.`} />
        </div>
      </main>
    </div>
  );
}
