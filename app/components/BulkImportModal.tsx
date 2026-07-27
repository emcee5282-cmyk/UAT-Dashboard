'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Upload, X, FileSpreadsheet, Download, CheckCircle2, AlertCircle, ChevronLeft, ChevronDown, ChevronUp, Pencil, Check, SkipForward, RotateCcw,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { downloadTemplate, type TemplateModule } from '../lib/templates';
import { displayNum, parseAmount } from '../lib/format';
import { parseWorkbookFile, mapSettlementRows, type SettlementImportRow } from '../lib/xlsxParser';
import {
  validateSettlementRows, checkBrandField, checkAgentNameField, checkWalletField, checkAmountField, checkDateField,
  type ValidationEntry, type ValidationConfig,
} from '../lib/settlementValidation';
import { detectDuplicatesWithinFile, mockExistingRecordCheck } from '../lib/duplicateDetector';
import { calculateImportSummary, type ImportSummary } from '../lib/importSummary';
import { mockImportRecords } from '../lib/importService';
import RecordFormModal, { type RecordFormField } from './RecordFormModal';

// Multi-step import wizard — UI/UX/validation-flow only, per explicit spec:
// nothing here writes to a database. The four business-logic modules
// (xlsxParser, settlementValidation, duplicateDetector, importSummary) and
// the import service are deliberately separate files so a new business
// rule, or the eventual real API call, only ever touches one of them —
// this component just orchestrates which step is showing and feeds it
// their output. 'confirmation' was folded into 'validation' — the review
// screen IS "Ready to Import" (step 3 of the wizard below), so a separate
// intermediate confirm screen was just an extra click.
type Step = 'upload' | 'scanning' | 'validation' | 'importing' | 'complete';

// The wizard only ever shows 3 conceptual phases — 'importing'/'complete'
// are outcomes of acting on step 3, not steps of their own.
const WIZARD_STEPS = ['Upload File', 'Validate File', 'Ready to Import'] as const;

function wizardStepIndex(step: Step): number {
  if (step === 'upload') return 0;
  if (step === 'scanning') return 1;
  return 2; // validation, importing, complete
}

const SCAN_MESSAGES = ['Uploading...', 'Reading Excel...', 'Validating Records...', 'Ready to Import'];

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Display-only reformat of the raw "M/D/YYYY" upload value into "Jul 21,
// 2026" for DateInput's initial value — copied verbatim from Cashout/Send
// Money Settlement (their own formatDateDisplay), so the edit form's date
// field reads identically everywhere it appears.
function formatDateForEdit(dateStr: string): string {
  const parts = (dateStr ?? '').trim().split('/');
  if (parts.length !== 3) return dateStr;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return dateStr;
  return `${MONTH_ABBR[m - 1]} ${d}, ${y}`;
}

// Proper-cases a raw uploaded value for display in the edit form (e.g.
// "nagad" -> "Nagad") — copied verbatim from Cashout Settlement's own
// toProperCase. Needed because RecordFormModal's own closed-set combobox
// check is case-sensitive against the canonical option list, and a
// freshly-uploaded file's casing is never guaranteed to match it.
function toProperCase(str: string): string {
  return str
    .toLowerCase()
    .split(/([\s-]+)/)
    .map((part) => (/^[\s-]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

// Compact amount display for the stat cards / Complete screen, which have
// too little width for a full comma-formatted figure once it reaches 7
// digits — 1,000,000+ collapses to "1.000M" instead of truncating.
// Anything under 1M keeps the normal full-precision format.
function formatCompactAmount(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(3)}M`;
  }
  return displayNum(value);
}

type BulkImportModalProps = {
  isOpen: boolean;
  onClose: () => void;
  moduleLabel: string;
  templateModule: TemplateModule;
  accentButtonClassName: string;
  // Send Money's accentButtonClassName resolves var(--product-accent),
  // which is scoped to [data-product="sendmoney"] (set on AppShell's own
  // wrapper) — createPortal renders this modal straight onto document.body,
  // outside that wrapper, so the variable silently fails to resolve and
  // the button paints invisible unless this is set to re-establish scope
  // on the portal root itself. Same fix UploadExcelModal already uses.
  dataProduct?: string;
  brandOptions: string[];
  walletOptions: string[];
  agentRoster: string[];
  remarksSuggestions: string[];
};

export default function BulkImportModal({
  isOpen,
  onClose,
  moduleLabel,
  templateModule,
  accentButtonClassName,
  dataProduct,
  brandOptions,
  walletOptions,
  agentRoster,
  remarksSuggestions,
}: BulkImportModalProps) {
  const [step, setStep] = useState<Step>('upload');
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanMessageIndex, setScanMessageIndex] = useState(0);
  const [rows, setRows] = useState<SettlementImportRow[]>([]);
  const [entries, setEntries] = useState<ValidationEntry[]>([]);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  // The colored summary card's error table starts collapsed — only the
  // adaptive green/red message shows until the user clicks to view details.
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  // The row currently open in the inline "fix it here" edit modal — lets a
  // simple mistake (wrong wallet, unrecognized shop name, etc.) get
  // corrected without re-exporting/re-uploading the whole file.
  const [editingRowNumber, setEditingRowNumber] = useState<number | null>(null);
  // Rows explicitly excluded from this import via the Skip action — never
  // mutates the row's own data, the original file, or anything downstream;
  // purely "don't include this one this time." Restore removes it again.
  const [skippedRows, setSkippedRows] = useState<Set<number>>(new Set());
  const [importDone, setImportDone] = useState(0);
  const [importCompletedAt, setImportCompletedAt] = useState<Date | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelImportRef = useRef<() => void>(() => {});
  // Lags `isOpen` by the exit-animation duration, same pattern as
  // RecordFormModal — the closing fade/scale actually gets to play instead
  // of the component unmounting mid-transition.
  const [rendered, setRendered] = useState(isOpen);
  const [closing, setClosing] = useState(false);

  const validationConfig: ValidationConfig = useMemo(() => ({
    brandOptions,
    walletOptions,
    agentRoster,
    remarksSuggestions,
  }), [brandOptions, walletOptions, agentRoster, remarksSuggestions]);

  // Shared by the initial scan AND every post-edit re-check — a single
  // source of truth for "given these rows, what issues do they have."
  const runValidation = useCallback((inputRows: SettlementImportRow[]): ValidationEntry[] => [
    ...validateSettlementRows(inputRows, validationConfig),
    ...detectDuplicatesWithinFile(inputRows),
    ...mockExistingRecordCheck(inputRows),
  ], [validationConfig]);

  // Same field set as the Settlement pages' own New/Edit Record modal
  // (brand/agentName/wallet/amount/remarks/date), fed by this modal's own
  // brandOptions/walletOptions/agentRoster/remarksSuggestions props so a
  // fix made here is held to the exact same rules as the rest of the app.
  const settlementRecordFields: RecordFormField[] = useMemo(() => [
    { key: 'brand', label: 'Brand', kind: 'combobox', options: brandOptions, required: true },
    { key: 'agentName', label: 'Agent Name', kind: 'combobox', options: agentRoster, required: true },
    { key: 'wallet', label: 'Wallet', kind: 'combobox', options: walletOptions, required: true },
    { key: 'amount', label: 'Amount', kind: 'amount', required: true },
    { key: 'remarks', label: 'Remarks', kind: 'combobox', options: remarksSuggestions, allowCustom: true },
    { key: 'date', label: 'Date', kind: 'date', required: true },
  ], [brandOptions, agentRoster, walletOptions, remarksSuggestions]);

  // Live, per-field business-rule check — the exact same functions
  // validateSettlementRows uses for the bulk scan, reused here so the Edit
  // Row dialog shows the REAL reason a field is invalid (and its "Available
  // X" list) instead of a generic message, and re-evaluates on every
  // keystroke so a fix clears the warning immediately.
  const getFieldHint = useCallback((key: string, value: string) => {
    switch (key) {
      case 'brand': return checkBrandField(value, validationConfig);
      case 'agentName': return checkAgentNameField(value, validationConfig);
      case 'wallet': return checkWalletField(value, validationConfig);
      case 'amount': return checkAmountField(value);
      case 'date': return checkDateField(value);
      default: return null;
    }
  }, [validationConfig]);

  const toggleSkip = useCallback((rowNumber: number) => {
    setSkippedRows((current) => {
      const next = new Set(current);
      if (next.has(rowNumber)) next.delete(rowNumber); else next.add(rowNumber);
      return next;
    });
  }, []);

  const editingRow = useMemo(() => rows.find((row) => row.row === editingRowNumber) ?? null, [rows, editingRowNumber]);

  const editingInitialValues: Record<string, string> = useMemo(() => {
    if (!editingRow) return { brand: '', agentName: '', wallet: '', amount: '', remarks: '', date: '' };
    return {
      brand: editingRow.brand.toUpperCase(),
      agentName: toProperCase(editingRow.agentName),
      wallet: toProperCase(editingRow.wallet),
      amount: editingRow.amount ? String(parseAmount(editingRow.amount)) : '',
      remarks: editingRow.remarks,
      date: formatDateForEdit(editingRow.date),
    };
  }, [editingRow]);

  const handleRowEditSave = useCallback((values: Record<string, string>) => {
    setRows((currentRows) => {
      const updatedRows = currentRows.map((row) => row.row === editingRowNumber
        ? { ...row, brand: values.brand ?? '', agentName: values.agentName ?? '', wallet: values.wallet ?? '', amount: values.amount ?? '', remarks: values.remarks ?? '', date: values.date ?? '' }
        : row);
      const newEntries = runValidation(updatedRows);
      setEntries(newEntries);
      setSummary(calculateImportSummary(updatedRows, newEntries));
      return updatedRows;
    });
  }, [editingRowNumber, runValidation]);

  // Resets the WIZARD's own progress back to step one — used by "Back",
  // "Import Another File", and once the modal has fully closed. Does NOT
  // itself close the modal (requestClose, below, does that).
  const resetWizardState = useCallback(() => {
    setStep('upload');
    setDragActive(false);
    setFile(null);
    setScanError(null);
    setScanMessageIndex(0);
    setRows([]);
    setEntries([]);
    setSummary(null);
    setIssuesExpanded(false);
    setEditingRowNumber(null);
    setSkippedRows(new Set());
    setImportDone(0);
    setImportCompletedAt(null);
    cancelImportRef.current();
  }, []);

  const requestClose = useCallback(() => {
    cancelImportRef.current();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      setRendered(true);
      setClosing(false);
    } else if (rendered) {
      setClosing(true);
      const timer = setTimeout(() => {
        setRendered(false);
        resetWizardState();
      }, 120);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Scanning — the real parse/validate work runs immediately, but the
  // status messages cycle for a believable stretch regardless of file
  // size, so the wizard never just flash-skips this step. Cancels its own
  // timers if the modal closes or a different file gets selected mid-scan.
  useEffect(() => {
    if (step !== 'scanning' || !file) return;
    let cancelled = false;
    setScanMessageIndex(0);
    setScanError(null);

    (async () => {
      let parsedRows: SettlementImportRow[] = [];
      let computedEntries: ValidationEntry[] = [];
      let failure: string | null = null;
      try {
        const parsed = await parseWorkbookFile(file);
        parsedRows = mapSettlementRows(parsed);
        computedEntries = runValidation(parsedRows);
      } catch (err) {
        failure = err instanceof Error ? err.message : 'Could not read this file.';
      }

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
      setEntries(computedEntries);
      setSummary(calculateImportSummary(parsedRows, computedEntries));
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

  // Only true blocking errors get their own error table — matches Opening
  // Balance's own Detected panel, where "Errors" means exactly the rows
  // that won't go through, nothing softer.
  const errorEntries = useMemo(
    () => entries.filter((entry) => entry.type === 'error').sort((a, b) => a.row - b.row),
    [entries]
  );

  // One row per RECORD (not per issue) — "Row 8 / 2 Validation Issues"
  // instead of two separate table rows. A row stays visible here even
  // after its issues are fixed as long as it's still Skipped, so Restore
  // remains reachable.
  const reviewRowGroups = useMemo(() => {
    const issuesByRow = new Map<number, ValidationEntry[]>();
    errorEntries.forEach((entry) => {
      if (!issuesByRow.has(entry.row)) issuesByRow.set(entry.row, []);
      issuesByRow.get(entry.row)!.push(entry);
    });
    const rowNumbers = new Set<number>(issuesByRow.keys());
    skippedRows.forEach((rowNumber) => rowNumbers.add(rowNumber));
    return Array.from(rowNumbers).sort((a, b) => a - b).map((rowNumber) => {
      const issues = issuesByRow.get(rowNumber) ?? [];
      const sourceRow = rows.find((row) => row.row === rowNumber);
      return {
        row: rowNumber,
        agent: sourceRow?.agentName || issues[0]?.agent || '(blank)',
        issues,
        skipped: skippedRows.has(rowNumber),
      };
    });
  }, [errorEntries, rows, skippedRows]);

  // Still blocking = has at least one real error AND hasn't been skipped.
  const activeErrorCount = useMemo(
    () => reviewRowGroups.filter((group) => group.issues.length > 0 && !group.skipped).length,
    [reviewRowGroups]
  );

  // Everything NOT going into this import — actively-erroring rows plus
  // anything the user explicitly Skipped (even if since fixed, since Skip
  // is a deliberate standalone choice, not undone by editing).
  const excludedRowNumbers = useMemo(() => {
    const set = new Set<number>(skippedRows);
    reviewRowGroups.forEach((group) => { if (group.issues.length > 0 && !group.skipped) set.add(group.row); });
    return set;
  }, [skippedRows, reviewRowGroups]);

  const readyRows = useMemo(() => rows.filter((row) => !excludedRowNumbers.has(row.row)), [rows, excludedRowNumbers]);
  const readyTotalAmount = useMemo(() => readyRows.reduce((sum, row) => sum + parseAmount(row.amount), 0), [readyRows]);

  const handleImportStart = useCallback(() => {
    setStep('importing');
    setImportDone(0);
    cancelImportRef.current = mockImportRecords(
      readyRows.length,
      (done) => setImportDone(done),
      () => {
        setImportCompletedAt(new Date());
        setStep('complete');
      }
    );
  }, [readyRows.length]);

  const downloadReport = useCallback(() => {
    const headers = ['Row', 'Agent Name', 'Field', 'Invalid Value', 'Error Message'];
    const data = errorEntries.map((entry) => [entry.row, entry.agent, entry.field, entry.value || '(blank)', entry.issue]);
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = [{ wch: 8 }, { wch: 20 }, { wch: 14 }, { wch: 18 }, { wch: 40 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Validation Report');
    const baseName = file?.name.replace(/\.[^.]+$/, '') ?? 'settlement_import';
    XLSX.writeFile(workbook, `${baseName}_errors.xlsx`);
  }, [errorEntries, file]);

  const canContinue = activeErrorCount === 0;
  const hasNonBlockingIssues = (summary?.warningCount ?? 0) + (summary?.duplicateCount ?? 0) > 0;

  const importedTimestampLabel = importCompletedAt
    ? importCompletedAt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

  // Enter confirms the current step's primary action — skipped when focus
  // is already on a button (native Enter-activates-button already covers
  // that case) so this never double-fires.
  const primaryAction = useMemo(() => {
    if (step === 'validation' && canContinue) return handleImportStart;
    if (step === 'complete') return requestClose;
    return null;
  }, [step, canContinue, handleImportStart, requestClose]);

  useEffect(() => {
    if (!rendered || closing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        requestClose();
        return;
      }
      if (event.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON' && document.activeElement?.tagName !== 'INPUT') {
        if (primaryAction) {
          event.preventDefault();
          primaryAction();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [rendered, closing, requestClose, primaryAction]);

  if (!rendered || typeof document === 'undefined') return null;

  const activeStepIndex = wizardStepIndex(step);
  // Bottom-left footer note — shown from the very first step onward (not
  // just once results are in) so the footer isn't left mostly blank on
  // Upload/Scanning; hidden only on the final success screen, which has
  // its own dedicated layout and footer buttons.
  const footerNote = step !== 'complete' ? (
    <div className="min-w-0 flex-1 pr-4">
      <p className="text-[10px] font-semibold text-muted-foreground">Note:</p>
      <p className="text-[10px] leading-snug text-muted-foreground">
        Only validated records will be imported. Please review warnings and errors before proceeding.
      </p>
    </div>
  ) : <div />;

  return (
    <>
      {createPortal(
        <div
          data-product={dataProduct}
          className={`fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 px-4 ${closing ? 'dt-modal-overlay-out' : 'dt-modal-overlay-in'}`}
          onClick={requestClose}
        >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Bulk Import ${moduleLabel}`}
        onClick={(event) => event.stopPropagation()}
        className={`flex h-[660px] max-h-[85vh] w-full max-w-[800px] flex-col rounded-xl border border-border bg-white shadow-xl dark:bg-[#2a2a2d] ${closing ? 'dt-modal-card-out' : 'dt-modal-card-in'}`}
      >
        <div className="flex items-start justify-between gap-3 p-6 pb-0">
          <div>
            <h2 className="text-[16px] font-bold text-foreground">Bulk Import {moduleLabel}</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {{
                upload: 'Upload a spreadsheet to begin.',
                scanning: 'Scanning your file...',
                validation: 'Review the results before importing.',
                importing: 'Importing your records...',
                complete: 'Your records have been imported.',
              }[step]}
            </p>
          </div>
          <button type="button" onClick={requestClose} aria-label="Close" className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]">
            <X size={16} />
          </button>
        </div>

        {/* Step indicator — hidden on the final success screen, which
            replaces the whole review UI with its own dedicated layout. */}
        {step !== 'complete' && (
          <div className="flex items-center gap-1.5 px-6 pb-3 pt-3">
            {WIZARD_STEPS.map((label, i) => {
              const status = i < activeStepIndex ? 'done' : i === activeStepIndex ? 'active' : 'upcoming';
              return (
                <div key={label} className="flex items-center gap-1.5">
                  <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    status === 'done' ? 'bg-emerald-600 text-white'
                      : status === 'active' ? `text-white ${accentButtonClassName.split(' ')[0]}`
                      : 'border border-border text-muted-foreground'
                  }`}>
                    {status === 'done' ? <Check size={11} /> : i + 1}
                  </div>
                  <span className={`text-[11px] font-medium ${status === 'upcoming' ? 'text-muted-foreground' : 'text-foreground'}`}>
                    {label}
                  </span>
                  {i < WIZARD_STEPS.length - 1 && <div className="mx-1 h-px w-5 shrink-0 bg-border" />}
                </div>
              );
            })}
          </div>
        )}

        <div key={step} className="dt-step-fade-in flex-1 overflow-y-auto border-t border-border px-6 py-4">
          {step === 'upload' && (
            <>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 p-3">
                <p className="text-[12px] font-medium text-foreground">Need the official template?</p>
                <button
                  type="button"
                  onClick={() => downloadTemplate(templateModule)}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:bg-transparent"
                >
                  <Download size={13} />
                  Download Latest Template
                </button>
              </div>

              <div
                onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
                onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
                onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`mt-4 flex h-[100px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 text-center transition-colors ${
                  dragActive ? 'border-[#2563EB] bg-[#EFF6FF] dark:bg-[#1e2a3d]' : 'border-border bg-muted/20 hover:bg-muted/40'
                }`}
              >
                <Upload size={22} className={dragActive ? 'text-[#2563EB]' : 'text-muted-foreground'} />
                <p className="text-[12px] font-semibold text-foreground">Drag &amp; drop your Excel file here</p>
                <p className="text-[11px] text-muted-foreground">or click to browse · Supports Settlement Template (.xlsx)</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(event) => handleFileSelected(event.target.files?.[0])}
                />
              </div>

              {scanError && (
                <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-400">
                  <AlertCircle size={13} className="shrink-0" />
                  {scanError}
                </div>
              )}
            </>
          )}

          {step === 'scanning' && (
            <div className="flex h-full flex-col items-center justify-center gap-4">
              <div className="w-full max-w-xs">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-[#2563EB] transition-all duration-200 ease-out"
                    style={{ width: `${((scanMessageIndex + 1) / SCAN_MESSAGES.length) * 100}%` }}
                  />
                </div>
              </div>
              <p key={scanMessageIndex} className="dt-fade-in text-[13px] font-medium text-foreground">
                {SCAN_MESSAGES[scanMessageIndex]}
              </p>
            </div>
          )}

          {step === 'validation' && summary && (
            <div>
              {/* File Information */}
              <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/20 p-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
                  <FileSpreadsheet size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-foreground">{file?.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {file ? (file.size / 1024).toFixed(0) : 0} KB · {summary.totalRows} rows · Modified {file ? new Date(file.lastModified).toLocaleDateString() : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={resetWizardState}
                  aria-label="Remove file"
                  className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Compact stat cards — Total Records / Ready / Total Amount /
                  Errors. Ready, Total Amount, and Errors all account for
                  Skip: a skipped row is never "ready", never counts toward
                  the passing amount, and never counts as a blocking error. */}
              <div className="mt-2.5 grid grid-cols-4 gap-2">
                <div className="flex items-center gap-2 rounded-xl border border-border p-1.5">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                    <FileSpreadsheet size={12} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold tabular-nums text-foreground">{summary.totalRows.toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">Total Records</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-border p-1.5">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                    <CheckCircle2 size={12} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold tabular-nums text-foreground">{readyRows.length.toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">Ready</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-border p-1.5">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                    <CheckCircle2 size={12} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-bold tabular-nums text-foreground">{formatCompactAmount(readyTotalAmount)}</p>
                    <p className="text-[10px] text-muted-foreground">Total Amount</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-border p-1.5">
                  <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
                    activeErrorCount === 0
                      ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                      : 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
                  }`}>
                    {activeErrorCount === 0 ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                  </div>
                  <div className="min-w-0">
                    <p className={`text-[14px] font-bold tabular-nums ${activeErrorCount > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                      {activeErrorCount}
                    </p>
                    <p className="text-[10px] text-muted-foreground">Errors</p>
                  </div>
                </div>
              </div>

              {/* Adaptive colored summary card — green when nothing's still
                  blocking, red otherwise. The panel itself (and its
                  chevron) stays reachable whenever there's ANYTHING to
                  review — including rows that are Skipped but no longer
                  actually invalid — so Restore is never stranded behind a
                  hidden panel. */}
              <div className={`mt-2.5 overflow-hidden rounded-xl border ${
                activeErrorCount > 0 ? 'border-rose-200 dark:border-rose-500/20' : 'border-emerald-200 dark:border-emerald-500/20'
              }`}>
                <button
                  type="button"
                  onClick={() => { if (reviewRowGroups.length > 0) setIssuesExpanded((current) => !current); }}
                  disabled={reviewRowGroups.length === 0}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors ${
                    activeErrorCount > 0
                      ? 'bg-rose-50 hover:bg-rose-100 dark:bg-rose-500/10 dark:hover:bg-rose-500/15'
                      : 'bg-emerald-50 dark:bg-emerald-500/10'
                  }`}
                >
                  <span className="flex items-start gap-2">
                    {activeErrorCount > 0
                      ? <AlertCircle size={15} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
                      : <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                    <span>
                      <span className={`block text-[12px] font-semibold ${activeErrorCount > 0 ? 'text-rose-700 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                        {activeErrorCount > 0 ? 'Validation issues detected' : 'No validation errors found'}
                      </span>
                      <span className={`block text-[11px] ${activeErrorCount > 0 ? 'text-rose-600/90 dark:text-rose-400/80' : 'text-emerald-600/90 dark:text-emerald-400/80'}`}>
                        {activeErrorCount > 0 ? 'Please review the rows below before continuing.' : 'This file is ready to import.'}
                      </span>
                    </span>
                  </span>
                  {reviewRowGroups.length > 0 && (
                    issuesExpanded
                      ? <ChevronUp size={14} className={`mt-0.5 shrink-0 ${activeErrorCount > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`} />
                      : <ChevronDown size={14} className={`mt-0.5 shrink-0 ${activeErrorCount > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`} />
                  )}
                </button>

                {/* Not rendered at all when there's nothing to review (per
                    spec: "Hide it completely if validation passes") — the
                    grid-template-rows 0fr/1fr trick below only handles the
                    smooth expand/collapse animation, it doesn't hide
                    content that's otherwise mounted. */}
                {reviewRowGroups.length > 0 && (
                <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                  issuesExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                }`}>
                  <div className="overflow-hidden">
                    <div className={`border-t ${activeErrorCount > 0 ? 'border-rose-200 dark:border-rose-500/20' : 'border-emerald-200 dark:border-emerald-500/20'}`}>
                      {errorEntries.length > 0 && (
                        <div className="flex items-center justify-end px-3 py-2">
                          <button
                            type="button"
                            onClick={downloadReport}
                            className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-white px-2 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-muted dark:bg-transparent"
                          >
                            <Download size={11} />
                            Download Error Report (.xlsx)
                          </button>
                        </div>
                      )}
                      {/* Sized to use the space actually available under a
                          fixed-height modal (not an arbitrary small cap) —
                          keeps its own scroll for anything beyond that,
                          instead of pushing the whole step tall enough to
                          need the outer content area to scroll too. */}
                      <div className="max-h-[208px] overflow-y-auto">
                        <table className="w-full border-collapse text-[10px]">
                          <thead className="sticky top-0 z-10 bg-white shadow-[0_2px_2px_-1px_rgba(0,0,0,0.15)] dark:bg-[#2a2a2d]">
                            <tr className="border-b border-border">
                              <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Row</th>
                              <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Agent Name</th>
                              <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Status</th>
                              <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Issues</th>
                              <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reviewRowGroups.map((group) => (
                              <tr
                                key={group.row}
                                className={`border-b border-border last:border-0 transition-opacity ${group.skipped ? 'opacity-50' : ''}`}
                              >
                                <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-foreground">{group.row}</td>
                                <td className="whitespace-nowrap px-2.5 py-1.5 text-foreground">{group.agent}</td>
                                <td className="whitespace-nowrap px-2.5 py-1.5">
                                  <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9px] font-medium ${
                                    group.skipped
                                      ? 'border-border bg-muted text-muted-foreground'
                                      : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-400'
                                  }`}>
                                    {group.skipped ? 'Skipped' : 'Error'}
                                  </span>
                                </td>
                                <td className="whitespace-nowrap px-2.5 py-1.5 text-muted-foreground">
                                  {group.issues.length > 0
                                    ? `${group.issues.length} Validation Issue${group.issues.length === 1 ? '' : 's'}`
                                    : 'No remaining issues'}
                                </td>
                                <td className="whitespace-nowrap px-2.5 py-1.5">
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => setEditingRowNumber(group.row)}
                                      aria-label={`Edit row ${group.row}`}
                                      title="Edit"
                                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]"
                                    >
                                      <Pencil size={12} />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => toggleSkip(group.row)}
                                      aria-label={group.skipped ? `Restore row ${group.row}` : `Skip row ${group.row}`}
                                      title={group.skipped ? 'Restore' : 'Skip'}
                                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]"
                                    >
                                      {group.skipped ? <RotateCcw size={12} /> : <SkipForward size={12} />}
                                    </button>
                                  </div>
                                </td>
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
            </div>
          )}

          {step === 'importing' && summary && (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-[13px] font-semibold text-foreground">Importing...</p>
              <p className="text-[12px] tabular-nums text-muted-foreground">{importDone} / {readyRows.length}</p>
              <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-[#2563EB] transition-all duration-150 ease-out"
                  style={{ width: `${readyRows.length ? (importDone / readyRows.length) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          {step === 'complete' && summary && (
            <div className="flex h-full flex-col">
              <div className="flex flex-col items-center justify-center gap-1.5 pb-4 pt-2 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-600 text-white">
                  <CheckCircle2 size={22} />
                </div>
                <p className="text-[15px] font-bold text-foreground">Import Completed</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground">Imported Records</p>
                  <p className="mt-0.5 text-[14px] font-bold tabular-nums text-foreground">{readyRows.length.toLocaleString()}</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground">Skipped Records</p>
                  <p className="mt-0.5 text-[14px] font-bold tabular-nums text-foreground">{skippedRows.size.toLocaleString()}</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground">Warnings</p>
                  <p className="mt-0.5 text-[14px] font-bold tabular-nums text-foreground">{(summary.warningCount + summary.duplicateCount).toLocaleString()}</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground">Total Amount Imported</p>
                  <p className="mt-0.5 truncate text-[14px] font-bold tabular-nums text-foreground">{formatCompactAmount(readyTotalAmount)}</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground">Imported Timestamp</p>
                  <p className="mt-0.5 text-[13px] font-semibold text-foreground">{importedTimestampLabel}</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground">Imported By</p>
                  <p className="mt-0.5 text-[13px] font-semibold text-foreground">Operations Admin</p>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border p-6 pt-4">
          {step === 'upload' && (
            <>
              {footerNote}
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={requestClose} className="rounded-lg border border-border px-4 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]">
                  Cancel
                </button>
              </div>
            </>
          )}
          {step === 'scanning' && (
            <>
              {footerNote}
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" disabled className="rounded-lg border border-border px-4 py-2 text-[12px] font-medium text-muted-foreground opacity-50">
                  Cancel
                </button>
              </div>
            </>
          )}
          {step === 'validation' && (
            <>
              {footerNote}
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={resetWizardState} className="flex items-center gap-1 rounded-lg border border-border px-4 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]">
                  <ChevronLeft size={13} />
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleImportStart}
                  disabled={!canContinue}
                  className={`rounded-lg px-4 py-2 text-[12px] font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${accentButtonClassName}`}
                >
                  {!canContinue ? 'Resolve Errors' : hasNonBlockingIssues ? 'Import Anyway' : 'Import Data'}
                </button>
              </div>
            </>
          )}
          {step === 'importing' && (
            <>
              {footerNote}
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" disabled className="rounded-lg border border-border px-4 py-2 text-[12px] font-medium text-muted-foreground opacity-50">
                  Cancel
                </button>
                <button type="button" disabled className={`rounded-lg px-4 py-2 text-[12px] font-semibold text-white opacity-50 ${accentButtonClassName}`}>
                  Importing...
                </button>
              </div>
            </>
          )}
          {step === 'complete' && (
            <>
              {footerNote}
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={resetWizardState} className="rounded-lg border border-border px-4 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]">
                  Import Another File
                </button>
                <button type="button" onClick={requestClose} className={`rounded-lg px-4 py-2 text-[12px] font-semibold text-white transition-colors ${accentButtonClassName}`}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
        document.body
      )}
      <RecordFormModal
        isOpen={editingRowNumber !== null}
        onClose={() => setEditingRowNumber(null)}
        onSave={handleRowEditSave}
        title={`Edit Row ${editingRowNumber ?? ''}`}
        fields={settlementRecordFields}
        initialValues={editingInitialValues}
        primaryButtonClassName={accentButtonClassName}
        getFieldHint={getFieldHint}
        dataProduct={dataProduct}
      />
    </>
  );
}
