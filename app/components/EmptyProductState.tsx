import { PlugZap } from 'lucide-react';

type EmptyProductStateProps = {
  title?: string;
  message?: string;
};

export default function EmptyProductState({
  title = 'No data source connected yet',
  message = 'This will populate once the data source is connected.',
}: EmptyProductStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <PlugZap size={20} className="text-muted-foreground" strokeWidth={1.75} />
      </div>
      <div>
        <p className="text-[13px] font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{message}</p>
      </div>
      <div className="mt-2 w-full max-w-sm space-y-2">
        <div className="skeleton h-3 w-full rounded-md opacity-40" />
        <div className="skeleton h-3 w-5/6 rounded-md opacity-40" />
        <div className="skeleton h-3 w-2/3 rounded-md opacity-40" />
      </div>
    </div>
  );
}
