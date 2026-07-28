'use client';

import { FileText } from 'lucide-react';
import { type EstimateImportRecord, formatImportTimestamp } from '../lib/estimateUpload';

// Shown as soon as the upload modal opens (not gated behind picking a file)
// so there's always visible proof of when this was last done, from any device.
export default function EstimateLastImportRow({
  record,
  highlighted,
  highlightedRowBg,
}: {
  record: EstimateImportRecord;
  highlighted?: boolean;
  highlightedRowBg?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-2 rounded-xl p-2.5 ${highlighted && highlightedRowBg ? highlightedRowBg : ''}`}>
      <div className="flex min-w-0 items-center gap-2">
        <FileText size={16} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold text-foreground">{record.fileName}</p>
          <p className="text-[11px] text-muted-foreground">{record.shopCount.toLocaleString()} Shops · {formatImportTimestamp(record.importedAt)}</p>
        </div>
      </div>
      <div className="shrink-0 text-right text-[11px] text-muted-foreground">
        <p>Imported by</p>
        <p className="font-medium text-foreground">{record.importedBy}</p>
      </div>
    </div>
  );
}
