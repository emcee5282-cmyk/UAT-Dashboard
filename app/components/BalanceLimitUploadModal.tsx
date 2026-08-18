'use client';

// Phase 8b — Balance Limit's own upload wizard. A dedicated component
// rather than a 4th moduleKind bolted onto BulkImportModal.tsx: Balance
// Limit is a full-snapshot REPLACE of agent_wallets, not a reviewable list
// of individually-editable records the way Settlement/Top Up/Opening are —
// it doesn't fit that component's per-row RecordFormModal editing model at
// all. What IS reused: the exact same wide-card wizard chrome
// (modalTheme.ts), the exact same stepper/stat-card/error-table visual
// language already established across every other bulk import in this app,
// and — most importantly — the exact same shop-name resolution functions
// Estimated Opening's own upload already trusts (app/lib/realShopName.ts),
// via app/lib/balanceLimitParser.ts. Client-side validation here is a
// preview only; the server independently re-parses and re-validates from
// scratch (app/lib/services/balanceLimitService.ts) before anything reaches
// PostgreSQL — nothing from this client request is trusted blindly.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Upload, X, FileSpreadsheet, Download, CheckCircle2, AlertCircle, ChevronRight, ChevronUp, ChevronDown, Check } from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  MODAL_OVERLAY_CLASS,
  MODAL_WIDE_CARD_CLASS,
  MODAL_GLYPH_CLASS,
  MODAL_GLYPH_STYLE,
  MODAL_CLOSE_BUTTON_CLASS,
  MODAL_GHOST_BUTTON_CLASS,
  MODAL_PRIMARY_BUTTON_SHAPE_CLASS,
} from './modalTheme';
import { parseWorkbookFile } from '../lib/xlsxParser';
import { mapBalanceLimitRows, type BalanceLimitRow } from '../lib/balanceLimitParser';
import { isValidNumericCell } from '../lib/uploadValidation';
import { downloadTemplate } from '../lib/templates';

type Product = 'cashout' | 'sendmoney';
type Step = 'upload' | 'scanning' | 'validation' | 'importing' | 'complete';
const WIZARD_STEPS = ['Upload File', 'Validate File', 'Ready to Import'] as const;
function wizardStepIndex(step: Step): number {
  if (step === 'upload') return 0;
  if (step === 'scanning') return 1;
  return 2;
}
const SCAN_MESSAGES = ['Uploading...', 'Reading Excel...', 'Validating Records...', 'Ready to Import'];

type RowIssue = { row: number; shopCode: string; field: string; value: string; issue: string };

// Client-side mirror of balanceLimitService.ts's own validateRow — same
// checks, same order, so a row flagged here is actually excluded server-side
// too, not silently included with a wrong total (same rule every other
// bulk-import preview in this app already follows). OLD/MANUAL rows never
// reach here — already filtered out before this is called (see the scanning
// effect below), same as the server.
function validatePreviewRow(row: BalanceLimitRow, agentRoster: Set<string>): RowIssue | null {
  if (!row.shopCode) {
    return { row: row.row, shopCode: row.rawAccount || '(blank)', field: 'Account', value: row.rawAccount, issue: 'Missing or invalid shop code' };
  }
  if (!agentRoster.has(row.shopCode.toLowerCase())) {
    return { row: row.row, shopCode: row.shopCode, field: 'Account', value: row.rawAccount, issue: 'No matching agent in roster' };
  }
  if (!isValidNumericCell(row.balance)) return { row: row.row, shopCode: row.shopCode, field: 'Balance', value: row.balance, issue: 'Invalid number format' };
  if (!isValidNumericCell(row.totalDP)) return { row: row.row, shopCode: row.shopCode, field: 'Total DP', value: row.totalDP, issue: 'Invalid number format' };
  if (!isValidNumericCell(row.totalWD)) return { row: row.row, shopCode: row.shopCode, field: 'Total WD', value: row.totalWD, issue: 'Invalid number format' };
  return null;
}

type BalanceLimitUploadModalProps = {
  isOpen: boolean;
  onClose: () => void;
  product: Product;
  dataProduct?: string;
  agentRoster: string[];
  accentButtonClassName: string;
  onImported?: () => void;
};

export default function BalanceLimitUploadModal({
  isOpen,
  onClose,
  product,
  dataProduct,
  agentRoster,
  accentButtonClassName,
  onImported,
}: BalanceLimitUploadModalProps) {
  const [step, setStep] = useState<Step>('upload');
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanMessageIndex, setScanMessageIndex] = useState(0);
  const [rows, setRows] = useState<BalanceLimitRow[]>([]);
  const [issues, setIssues] = useState<RowIssue[]>([]);
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ validCount: number; errorCount: number; rowCount: number } | null>(null);
  const [importedAt, setImportedAt] = useState<Date | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rendered, setRendered] = useState(isOpen);
  const [closing, setClosing] = useState(false);

  const resetWizardState = useCallback(() => {
    setStep('upload');
    setDragActive(false);
    setFile(null);
    setScanError(null);
    setScanMessageIndex(0);
    setRows([]);
    setIssues([]);
    setIssuesExpanded(false);
    setImportError(null);
    setImportResult(null);
    setImportedAt(null);
  }, []);

  const requestClose = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (isOpen) {
      setRendered(true);
      setClosing(false);
    } else if (rendered) {
      setClosing(true);
      const timer = setTimeout(() => { setRendered(false); resetWizardState(); }, 120);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (step !== 'scanning' || !file) return;
    let cancelled = false;
    setScanMessageIndex(0);
    setScanError(null);

    (async () => {
      let parsedRows: BalanceLimitRow[] = [];
      let computedIssues: RowIssue[] = [];
      let failure: string | null = null;
      const roster = new Set(agentRoster.map((a) => a.toLowerCase()));
      // TEMPORARY perf-verification instrumentation — remove once the
      // server-side brand-backfill fix is confirmed against a real upload;
      // client-side parse/validate was already profiled as negligible
      // (~245ms for 5,283 rows) but kept here too for a real side-by-side
      // number on an actual file.
      console.time('[BalanceLimit] client parse+map+validate');
      try {
        const parsed = await parseWorkbookFile(file);
        const allRows = mapBalanceLimitRows(parsed, product);
        // OLD/MANUAL accounts are placeholder/deprecated rows, never real
        // shops — silently excluded from Total Records/Ready/Errors
        // entirely, not flagged as errors. Matches the server-side filter
        // in balanceLimitService.ts exactly, so the preview's counts here
        // are never out of sync with what actually gets imported.
        parsedRows = allRows.filter((r) => r.shopCode !== 'OLD' && r.shopCode !== 'MANUAL');
        computedIssues = parsedRows.map((r) => validatePreviewRow(r, roster)).filter((x): x is RowIssue => x !== null);
      } catch (err) {
        failure = err instanceof Error ? err.message : 'Could not read this file.';
      }
      // Ends here, before the artificial SCAN_MESSAGES delay below (a fixed
      // UX pause, not real work) — this number is the actual client cost.
      console.timeEnd('[BalanceLimit] client parse+map+validate');

      for (let i = 0; i < SCAN_MESSAGES.length; i++) {
        if (cancelled) return;
        setScanMessageIndex(i);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      if (cancelled) return;

      if (failure) {
        setScanError(failure);
        setStep('upload');
        return;
      }
      setRows(parsedRows);
      setIssues(computedIssues);
      setStep('validation');
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, file]);

  const handleFileSelected = useCallback((selected: File | undefined | null) => {
    if (!selected) return;
    setFile(selected);
    setStep('scanning');
  }, []);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    handleFileSelected(event.dataTransfer.files?.[0]);
  }, [handleFileSelected]);

  const readyCount = rows.length - issues.length;
  const canContinue = issues.length === 0 && rows.length > 0;

  const handleImportStart = useCallback(async () => {
    if (!file) return;
    setStep('importing');
    setImportError(null);
    // TEMPORARY perf-verification instrumentation — remove once the
    // server-side brand-backfill fix is confirmed. Covers upload + full
    // server processing (parse/validate/write) as one wall-clock number;
    // the server's own console.time breakdown (balanceLimitService.ts)
    // shows where inside that time actually goes.
    console.time('[BalanceLimit] upload+import round-trip');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('product', product);
      formData.append('uploadedBy', 'Operations Admin');
      const res = await fetch('/api/v2/import/balance-limit', { method: 'POST', body: formData });
      console.timeEnd('[BalanceLimit] upload+import round-trip');
      const result = await res.json().catch(() => null);
      if (!res.ok) throw new Error(result?.error || 'Import failed.');
      setImportResult({ validCount: result.validCount, errorCount: result.errorCount, rowCount: result.rowCount });
      setImportedAt(new Date());
      setStep('complete');
      onImported?.();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed.');
      setStep('validation');
    }
  }, [file, product, onImported]);

  const downloadReport = useCallback(() => {
    const headers = ['Row', 'Shop Code', 'Field', 'Invalid Value', 'Issue'];
    const data = issues.map((e) => [e.row, e.shopCode, e.field, e.value || '(blank)', e.issue]);
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = [{ wch: 8 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 36 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Validation Report');
    const baseName = file?.name.replace(/\.[^.]+$/, '') ?? 'balance_limit';
    XLSX.writeFile(workbook, `${baseName}_errors.xlsx`);
  }, [issues, file]);

  useEffect(() => {
    if (!rendered || closing) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [rendered, closing, requestClose]);

  if (!rendered || typeof document === 'undefined') return null;

  const activeStepIndex = wizardStepIndex(step);

  return createPortal(
    <div data-product={dataProduct} className={MODAL_OVERLAY_CLASS(closing)} onClick={requestClose}>
      <div role="dialog" aria-modal="true" aria-label="Bulk Import Balance Limit" onClick={(e) => e.stopPropagation()} className={MODAL_WIDE_CARD_CLASS(closing)}>
        <div className="flex items-start justify-between gap-3 p-6 pb-0">
          <div className="flex items-center gap-2.5">
            <span className={MODAL_GLYPH_CLASS} style={MODAL_GLYPH_STYLE}><Upload size={16} /></span>
            <div>
              <h2 className="text-[16px] font-bold text-foreground">Bulk Import Balance Limit</h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {{
                  upload: 'Upload a spreadsheet to begin.',
                  scanning: 'Scanning your file...',
                  validation: 'Review the results before importing.',
                  importing: 'Importing your records...',
                  complete: 'Your records have been imported.',
                }[step]}
              </p>
            </div>
          </div>
          <button type="button" onClick={requestClose} aria-label="Close" className={MODAL_CLOSE_BUTTON_CLASS}><X size={14} /></button>
        </div>

        {step !== 'complete' && (
          <div className="flex items-center gap-2 px-6 pb-4 pt-3.5">
            {WIZARD_STEPS.map((label, i) => {
              const status = i < activeStepIndex ? 'done' : i === activeStepIndex ? 'active' : 'upcoming';
              return (
                <div key={label} className="flex flex-1 items-center gap-2 last:flex-none">
                  <div className="flex shrink-0 items-center gap-2">
                    <div
                      className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-[11px] font-bold transition-colors ${
                        status === 'done' ? 'border-emerald-500 bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                          : status === 'active' ? 'border-transparent text-white shadow-[0_4px_10px_-2px_var(--product-accent)]'
                          : 'border-border text-muted-foreground'
                      }`}
                      style={status === 'active' ? MODAL_GLYPH_STYLE : undefined}
                    >
                      {status === 'done' ? <Check size={12} /> : i + 1}
                    </div>
                    <span className={`whitespace-nowrap text-[12.5px] font-semibold ${status === 'upcoming' ? 'text-muted-foreground' : 'text-foreground'}`}>{label}</span>
                  </div>
                  {i < WIZARD_STEPS.length - 1 && (
                    <div className={`h-[1.5px] min-w-[20px] flex-1 rounded-full ${status === 'done' ? '' : 'bg-border'}`} style={status === 'done' ? MODAL_GLYPH_STYLE : undefined} />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div key={step} className="dt-step-fade-in min-h-0 flex-1 overflow-y-auto border-t border-border px-6 py-4">
          {step === 'upload' && (
            <>
              <div className="mb-3.5 flex items-center justify-between gap-3 rounded-[14px] border border-border bg-muted/20 p-3.5">
                <p className="text-[13px] font-semibold text-foreground">Need the official template?</p>
                <button
                  type="button"
                  onClick={() => downloadTemplate(product === 'cashout' ? 'balanceLimitCashout' : 'balanceLimitSendMoney')}
                  className="flex shrink-0 items-center gap-1.5 rounded-[9px] border border-border bg-white px-3 py-2 text-[12px] font-semibold text-foreground transition-colors hover:border-muted-foreground/40 dark:bg-transparent"
                >
                  <Download size={13} />
                  Download Latest Template
                </button>
              </div>
              <div
                onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`flex h-[130px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed px-4 text-center transition-colors ${
                  dragActive ? 'border-[color:var(--product-accent)] bg-[color:var(--product-accent-soft)]' : 'border-border bg-muted/20 hover:border-[color:var(--product-accent)] hover:bg-[color:var(--product-accent-soft)]'
                }`}
              >
                <span className={MODAL_GLYPH_CLASS} style={MODAL_GLYPH_STYLE}><Upload size={17} /></span>
                <p className="mt-1 text-[13.5px] font-bold text-foreground">Drag &amp; drop your Excel file here</p>
                <p className="text-[11.5px] text-muted-foreground">or click to browse · Supports Balance Limit ({product === 'cashout' ? 'Cashout' : 'Send Money'}) (.xlsx)</p>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => handleFileSelected(e.target.files?.[0])} />
              </div>
              {scanError && (
                <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-400">
                  <AlertCircle size={13} className="shrink-0" />{scanError}
                </div>
              )}
            </>
          )}

          {step === 'scanning' && (
            <div className="flex h-full flex-col items-center justify-center gap-4">
              <div className="w-full max-w-xs">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-[color:var(--product-accent)] transition-all duration-200 ease-out" style={{ width: `${((scanMessageIndex + 1) / SCAN_MESSAGES.length) * 100}%` }} />
                </div>
              </div>
              <p key={scanMessageIndex} className="dt-fade-in text-[13px] font-medium text-foreground">{SCAN_MESSAGES[scanMessageIndex]}</p>
            </div>
          )}

          {step === 'validation' && (
            <div>
              <div className="flex items-center gap-3 rounded-[14px] border border-border bg-muted/20 p-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white"><FileSpreadsheet size={18} /></div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-foreground">{file?.name}</p>
                  <p className="text-[11px] text-muted-foreground">{file ? (file.size / 1024).toFixed(0) : 0} KB · {rows.length} rows · Modified {file ? new Date(file.lastModified).toLocaleDateString() : ''}</p>
                </div>
                <button type="button" onClick={resetWizardState} aria-label="Remove file" className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                  <X size={16} />
                </button>
              </div>

              <div className="mt-2.5 grid grid-cols-3 gap-2">
                <div className="flex items-center gap-2 rounded-[14px] border border-border p-1.5">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground"><FileSpreadsheet size={12} /></div>
                  <div className="min-w-0"><p className="text-[14px] font-bold tabular-nums text-foreground">{rows.length.toLocaleString()}</p><p className="text-[10px] text-muted-foreground">Total Records</p></div>
                </div>
                <div className="flex items-center gap-2 rounded-[14px] border border-border p-1.5">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"><CheckCircle2 size={12} /></div>
                  <div className="min-w-0"><p className="text-[14px] font-bold tabular-nums text-foreground">{readyCount.toLocaleString()}</p><p className="text-[10px] text-muted-foreground">Ready</p></div>
                </div>
                <div className="flex items-center gap-2 rounded-[14px] border border-border p-1.5">
                  <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${issues.length === 0 ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400' : 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'}`}>
                    {issues.length === 0 ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                  </div>
                  <div className="min-w-0"><p className={`text-[14px] font-bold tabular-nums ${issues.length > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>{issues.length}</p><p className="text-[10px] text-muted-foreground">Errors</p></div>
                </div>
              </div>

              <div className={`mt-2.5 overflow-hidden rounded-[14px] border ${issues.length > 0 ? 'border-rose-200 dark:border-rose-500/20' : 'border-emerald-200 dark:border-emerald-500/20'}`}>
                <button
                  type="button"
                  onClick={() => { if (issues.length > 0) setIssuesExpanded((v) => !v); }}
                  disabled={issues.length === 0}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors ${issues.length > 0 ? 'bg-rose-50 hover:bg-rose-100 dark:bg-rose-500/10 dark:hover:bg-rose-500/15' : 'bg-emerald-50 dark:bg-emerald-500/10'}`}
                >
                  <span className="flex items-start gap-2">
                    {issues.length > 0 ? <AlertCircle size={15} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" /> : <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                    <span>
                      <span className={`block text-[12px] font-semibold ${issues.length > 0 ? 'text-rose-700 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'}`}>{issues.length > 0 ? 'Validation issues detected' : 'No validation errors found'}</span>
                      <span className={`block text-[11px] ${issues.length > 0 ? 'text-rose-600/90 dark:text-rose-400/80' : 'text-emerald-600/90 dark:text-emerald-400/80'}`}>{issues.length > 0 ? 'Please review the rows below before continuing.' : 'This file is ready to import.'}</span>
                    </span>
                  </span>
                  {issues.length > 0 && (issuesExpanded ? <ChevronUp size={14} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" /> : <ChevronDown size={14} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />)}
                </button>
                {issues.length > 0 && (
                  <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${issuesExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                    <div className="overflow-hidden">
                      <div className="border-t border-rose-200 dark:border-rose-500/20">
                        <div className="flex items-center justify-end px-3 py-2">
                          <button type="button" onClick={downloadReport} className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-white px-2 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-muted dark:bg-transparent">
                            <Download size={11} />Download Error Report (.xlsx)
                          </button>
                        </div>
                        <div className="max-h-[208px] overflow-auto">
                          <table className="w-full border-collapse text-[10px]">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_2px_2px_-1px_rgba(0,0,0,0.15)] dark:bg-[#2a2a2d]">
                              <tr className="border-b border-border">
                                <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Row</th>
                                <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Shop Code</th>
                                <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Field</th>
                                <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Issue</th>
                              </tr>
                            </thead>
                            <tbody>
                              {issues.map((e, i) => (
                                <tr key={`${e.row}-${e.field}-${i}`} className="border-b border-border last:border-0">
                                  <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-foreground">{e.row}</td>
                                  <td className="whitespace-nowrap px-2.5 py-1.5 text-foreground">{e.shopCode}</td>
                                  <td className="whitespace-nowrap px-2.5 py-1.5 text-muted-foreground">{e.field}</td>
                                  <td className="whitespace-nowrap px-2.5 py-1.5 text-rose-600 dark:text-rose-400">{e.issue}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {importError && (
                <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-400">
                  <AlertCircle size={13} className="shrink-0" />{importError}
                </div>
              )}

              <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                <AlertCircle size={13} className="shrink-0" />
                This replaces the entire current Balance Limit dataset for {product === 'cashout' ? 'Cashout' : 'Send Money'} — any shop not in this file will show no wallet data after import.
              </div>
            </div>
          )}

          {step === 'importing' && (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-[13px] font-semibold text-foreground">Importing...</p>
              <p className="text-[12px] text-muted-foreground">This may take a few seconds.</p>
              <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted"><div className="h-full w-2/3 animate-pulse rounded-full bg-[color:var(--product-accent)]" /></div>
            </div>
          )}

          {step === 'complete' && importResult && (
            <div className="flex h-full flex-col">
              <div className="flex flex-col items-center justify-center gap-1.5 pb-4 pt-2 text-center">
                <div className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-emerald-50 text-emerald-600 shadow-[0_4px_14px_-2px_rgba(16,185,129,0.35)] dark:bg-emerald-500/15 dark:text-emerald-400">
                  <CheckCircle2 size={22} />
                </div>
                <p className="text-[15px] font-bold text-foreground">Import Completed</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-[14px] border border-border p-3"><p className="text-[10px] text-muted-foreground">Imported Records</p><p className="mt-0.5 text-[14px] font-bold tabular-nums text-foreground">{importResult.validCount.toLocaleString()}</p></div>
                <div className="rounded-[14px] border border-border p-3"><p className="text-[10px] text-muted-foreground">Skipped Records</p><p className="mt-0.5 text-[14px] font-bold tabular-nums text-foreground">{importResult.errorCount.toLocaleString()}</p></div>
                <div className="rounded-[14px] border border-border p-3"><p className="text-[10px] text-muted-foreground">Product</p><p className="mt-0.5 text-[13px] font-semibold text-foreground">{product === 'cashout' ? 'Cashout' : 'Send Money'}</p></div>
                <div className="rounded-[14px] border border-border p-3"><p className="text-[10px] text-muted-foreground">Imported At</p><p className="mt-0.5 text-[13px] font-semibold text-foreground">{importedAt ? importedAt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</p></div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border p-6 pt-4">
          {step === 'upload' && (
            <>
              <div className="min-w-0 flex-1 pr-4"><p className="text-[10px] leading-snug text-muted-foreground">Only validated records will be imported. Please review warnings and errors before proceeding.</p></div>
              <div className="flex shrink-0 items-center gap-3"><button type="button" onClick={requestClose} className={MODAL_GHOST_BUTTON_CLASS}>Cancel</button></div>
            </>
          )}
          {step === 'scanning' && (
            <>
              <div className="min-w-0 flex-1 pr-4" />
              <div className="flex shrink-0 items-center gap-3"><button type="button" disabled className={`${MODAL_GHOST_BUTTON_CLASS} opacity-50`}>Cancel</button></div>
            </>
          )}
          {step === 'validation' && (
            <>
              <div className="min-w-0 flex-1 pr-4" />
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={resetWizardState} className={MODAL_GHOST_BUTTON_CLASS}>Back</button>
                <button type="button" onClick={handleImportStart} disabled={!canContinue} className={`${MODAL_PRIMARY_BUTTON_SHAPE_CLASS} ${accentButtonClassName}`}>
                  {!canContinue ? 'Resolve Errors' : 'Import Data'}
                  {canContinue && <ChevronRight size={13} />}
                </button>
              </div>
            </>
          )}
          {step === 'importing' && (
            <>
              <div className="min-w-0 flex-1 pr-4" />
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" disabled className={`${MODAL_GHOST_BUTTON_CLASS} opacity-50`}>Cancel</button>
                <button type="button" disabled className={`${MODAL_PRIMARY_BUTTON_SHAPE_CLASS} opacity-50 ${accentButtonClassName}`}>Importing...</button>
              </div>
            </>
          )}
          {step === 'complete' && (
            <>
              <div className="min-w-0 flex-1 pr-4" />
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={resetWizardState} className={MODAL_GHOST_BUTTON_CLASS}>Import Another File</button>
                <button type="button" onClick={requestClose} className={`${MODAL_PRIMARY_BUTTON_SHAPE_CLASS} ${accentButtonClassName}`}><Check size={13} />Close</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
