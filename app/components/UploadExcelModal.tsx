'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Upload, X, FileSpreadsheet, CheckCircle2, AlertCircle, Store, FileText, User, Clock, ChevronUp, ChevronDown, Download } from 'lucide-react';
import * as XLSX from 'xlsx';
import { fromManilaWallClockMs } from '../lib/businessDate';
import { isValidNumericCell } from '../lib/uploadValidation';

type ImportRecord = { fileName: string; shopCount: number; importedAt: string; importedBy: string };

// One row skipped during the upload preview's own validation — mirrors
// exactly what app/lib/estimatedOpening.ts's aggregateByShop skips
// server-side (same isValidNumericCell check), so the preview never
// promises a row was skipped when the actual import would've kept it.
type UploadRowError = {
  row: number;
  shopCode: string;
  shopName: string;
  column: string;
  value: string;
  message: string;
};

// Inverse of the server's own "MM/DD/YYYY HH:MM AM/PM" timestamp format
// (app/lib/estimatedOpening.ts's formatUploadTimestamp) — written in Manila
// wall-clock time, so parsed the same way here regardless of the viewer's
// own device timezone.
function parseServerTimestamp(str: string): Date | null {
  const match = str.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  const [, mm, dd, yyyy, hh, min, ampm] = match;
  let hours = parseInt(hh, 10);
  if (/PM/i.test(ampm) && hours !== 12) hours += 12;
  if (/AM/i.test(ampm) && hours === 12) hours = 0;
  const manilaWallClockMs = Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), hours, parseInt(min, 10));
  return fromManilaWallClockMs(manilaWallClockMs);
}

// "Jul 14, 2026 01:42 PM" — display-only formatting for the Last
// Import/Import Success UI. Explicit Asia/Manila timeZone so this always
// reads as the business's own time, regardless of the viewer's own
// device/browser timezone.
function formatImportTimestamp(serverTimestamp: string): string {
  const date = parseServerTimestamp(serverTimestamp);
  if (!date) return serverTimestamp;
  const datePart = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' });
  const timePart = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' });
  return `${datePart} ${timePart}`;
}

// Shown as soon as the upload modal opens (not gated behind picking a file)
// so there's always visible proof of when this was last done, from any device.
function LastImportRow({ record, highlighted, highlightedRowBg }: { record: ImportRecord; highlighted?: boolean; highlightedRowBg: string }) {
  return (
    <div className={`mt-2 flex items-center justify-between gap-2 rounded-xl p-2.5 ${highlighted ? highlightedRowBg : ''}`}>
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

// The handful of class strings that differ between Cashout (hardcoded
// indigo) and Send Money (var(--product-accent)) — everything else about
// the modal is identical between products.
export type UploadExcelModalAccent = {
  dragActiveBorder: string;
  dragActiveBg: string;
  dragActiveIcon: string;
  progressBarFill: string;
  primaryButton: string;
  shopBadgeBg: string;
  shopBadgeText: string;
  highlightedRowBg: string;
  filterActiveText?: string;
};

type UploadExcelModalProps = {
  isOpen: boolean;
  onClose: () => void;
  // Called after a successful import + "Done" click, so the caller can
  // refetch its own table data.
  onImported: () => void;
  // Component appends /estimated-balance (GET, for Last Import) and
  // /upload-estimated-balance (POST, to actually import) to this.
  apiBasePath: string;
  // Same contract as extractRealShopName/extractSendMoneyShopName — returns
  // the shop name, or a falsy value if the row's Account cell is missing/invalid.
  extractShopName: (rawAccount: string | number) => string;
  // Shop names that should be silently skipped from DP/WD validation (not
  // counted as errors) — e.g. ['OLD', 'MANUAL'] for Cashout, ['OLD'] for Send Money.
  skipShopNames: string[];
  accent: UploadExcelModalAccent;
  // Optional data-product attribute on the overlay, for product-scoped CSS/E2E hooks.
  dataProduct?: string;
};

export default function UploadExcelModal({
  isOpen,
  onClose,
  onImported,
  apiBasePath,
  extractShopName,
  skipShopNames,
  accent,
  dataProduct,
}: UploadExcelModalProps) {
  const [uploadDragActive, setUploadDragActive] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadParsed, setUploadParsed] = useState<{ headerRow: (string | number)[]; dataRows: (string | number)[][] } | null>(null);
  const [uploadDetectedShops, setUploadDetectedShops] = useState(0);
  const [uploadDetectedErrors, setUploadDetectedErrors] = useState(0);
  const [uploadRowErrors, setUploadRowErrors] = useState<UploadRowError[]>([]);
  const [uploadErrorsExpanded, setUploadErrorsExpanded] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'importing' | 'success' | 'error'>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportRecord | null>(null);
  const [lastImport, setLastImport] = useState<ImportRecord | null>(null);
  const uploadFileInputRef = useRef<HTMLInputElement>(null);
  const uploadProgressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    fetch(`${apiBasePath}/estimated-balance?t=${Date.now()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { lastImport: ImportRecord | null } | null) => {
        if (data?.lastImport) setLastImport(data.lastImport);
      })
      .catch(() => {
        // Couldn't reach the server — just skip showing Last Import rather
        // than blocking the modal from opening.
      });
  }, [isOpen, apiBasePath]);

  const resetUploadState = useCallback(() => {
    setUploadedFile(null);
    setUploadParsed(null);
    setUploadDetectedShops(0);
    setUploadDetectedErrors(0);
    setUploadRowErrors([]);
    setUploadErrorsExpanded(false);
    setUploadStatus('idle');
    setUploadProgress(0);
    setUploadError(null);
    setImportResult(null);
    if (uploadProgressTimerRef.current) {
      clearInterval(uploadProgressTimerRef.current);
      uploadProgressTimerRef.current = null;
    }
  }, []);

  const closeUploadModal = useCallback(() => {
    setUploadDragActive(false);
    resetUploadState();
    onClose();
  }, [resetUploadState, onClose]);

  const handleUploadFileSelected = useCallback(async (file: File | undefined | null) => {
    if (!file) return;
    setUploadedFile(file);
    setUploadStatus('idle');
    setUploadError(null);
    setImportResult(null);

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows: (string | number)[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
      const [headerRow, ...dataRows] = rows;
      if (!headerRow || headerRow.length === 0) {
        throw new Error('The file appears to be empty.');
      }
      setUploadParsed({ headerRow, dataRows });

      // Preview counts — mirrors the server's own aggregateByShop grouping
      // (same shop-name extraction, same skip list, same numeric-cell check)
      // so a row flagged as an error here is actually excluded at import
      // time too, not silently included with a wrong total.
      const accountCol = headerRow.findIndex((h) => String(h ?? '').trim().toLowerCase() === 'account');
      if (accountCol === -1) {
        throw new Error('The file is missing an "Account" column.');
      }
      const dpCol = headerRow.findIndex((h) => String(h ?? '').trim().toLowerCase() === 'total dp');
      const wdCol = headerRow.findIndex((h) => String(h ?? '').trim().toLowerCase() === 'total wd');

      const errorRowNumbers = new Set<number>();
      const rowErrors: UploadRowError[] = [];
      dataRows.forEach((row, i) => {
        // +1 for 0-index, +1 for the header row — matches the row number
        // as it appears in the spreadsheet itself.
        const rowNumber = i + 2;
        const rawAccount = row[accountCol];
        const shopCode = String(rawAccount ?? '').trim() || '(blank)';
        const shopName = extractShopName(rawAccount);

        if (!shopName) {
          errorRowNumbers.add(rowNumber);
          rowErrors.push({
            row: rowNumber, shopCode, shopName: '—', column: 'Account',
            value: String(rawAccount ?? ''), message: 'Missing or invalid shop code',
          });
          return;
        }
        if (skipShopNames.includes(shopName)) return;

        if (dpCol !== -1 && !isValidNumericCell(row[dpCol])) {
          errorRowNumbers.add(rowNumber);
          rowErrors.push({
            row: rowNumber, shopCode, shopName, column: 'Total DP',
            value: String(row[dpCol] ?? ''), message: 'Invalid number format',
          });
        }
        if (wdCol !== -1 && !isValidNumericCell(row[wdCol])) {
          errorRowNumbers.add(rowNumber);
          rowErrors.push({
            row: rowNumber, shopCode, shopName, column: 'Total WD',
            value: String(row[wdCol] ?? ''), message: 'Invalid number format',
          });
        }
      });
      setUploadDetectedShops(dataRows.length);
      setUploadDetectedErrors(errorRowNumbers.size);
      setUploadRowErrors(rowErrors);
    } catch (err) {
      setUploadStatus('error');
      setUploadError(err instanceof Error ? err.message : 'Could not read this file.');
    }
  }, [extractShopName, skipShopNames]);

  const downloadErrorReport = useCallback(() => {
    const headers = ['Row', 'Shop Code', 'Shop Name', 'Column', 'Invalid Value', 'Error Message'];
    const data = uploadRowErrors.map((e) => [e.row, e.shopCode, e.shopName, e.column, e.value, e.message]);
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Import Errors');
    const baseName = uploadedFile?.name.replace(/\.[^.]+$/, '') ?? 'upload';
    XLSX.writeFile(workbook, `${baseName}_errors.xlsx`);
  }, [uploadRowErrors, uploadedFile]);

  const handleUploadDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setUploadDragActive(false);
    handleUploadFileSelected(event.dataTransfer.files?.[0]);
  }, [handleUploadFileSelected]);

  const handleImportData = useCallback(async () => {
    if (!uploadedFile || !uploadParsed) return;
    setUploadStatus('importing');
    setUploadProgress(0);
    setUploadError(null);

    // No real progress events from the server (single request/response) —
    // simulate a climb to 90% while in flight, then complete to 100% once
    // the response actually arrives.
    uploadProgressTimerRef.current = setInterval(() => {
      setUploadProgress((current) => (current >= 90 ? current : current + Math.random() * 12));
    }, 250);

    try {
      const res = await fetch(`${apiBasePath}/upload-estimated-balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...uploadParsed, fileName: uploadedFile.name }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error || 'Import failed.');
      }
      const result: { uploadedAt: string; shopCount: number } = await res.json();

      if (uploadProgressTimerRef.current) {
        clearInterval(uploadProgressTimerRef.current);
        uploadProgressTimerRef.current = null;
      }
      setUploadProgress(100);

      // The server appended this exact entry to its own Import Log in the
      // same operation — reuse its own timestamp/shopCount rather than
      // re-deriving them, so this matches what any other device will read.
      const record: ImportRecord = {
        fileName: uploadedFile.name,
        shopCount: result.shopCount,
        importedAt: result.uploadedAt,
        importedBy: 'Operations Admin',
      };
      setImportResult(record);
      setLastImport(record);
      setUploadStatus('success');
    } catch (err) {
      if (uploadProgressTimerRef.current) {
        clearInterval(uploadProgressTimerRef.current);
        uploadProgressTimerRef.current = null;
      }
      setUploadStatus('error');
      setUploadError(err instanceof Error ? err.message : 'Import failed.');
    }
  }, [uploadedFile, uploadParsed, apiBasePath]);

  const handleImportDone = useCallback(() => {
    setUploadDragActive(false);
    resetUploadState();
    onClose();
    onImported();
  }, [resetUploadState, onClose, onImported]);

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div
      data-product={dataProduct}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 px-4"
      onClick={closeUploadModal}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-white p-5 shadow-xl dark:bg-[#2a2a2d]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-bold text-foreground">Upload Opening Balance Data</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Upload the raw Excel file to generate the next day&apos;s Opening Balance.
            </p>
          </div>
          <button
            type="button"
            onClick={closeUploadModal}
            aria-label="Close"
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* File area — dropzone or file card, same fixed height so
            switching between them doesn't resize the modal. */}
        {!uploadedFile ? (
          <div
            onDragEnter={(event) => { event.preventDefault(); setUploadDragActive(true); }}
            onDragOver={(event) => { event.preventDefault(); setUploadDragActive(true); }}
            onDragLeave={(event) => { event.preventDefault(); setUploadDragActive(false); }}
            onDrop={handleUploadDrop}
            onClick={() => uploadFileInputRef.current?.click()}
            className={`mt-4 flex h-[72px] cursor-pointer items-center justify-center gap-3 rounded-xl border-2 border-dashed px-4 text-center transition-colors ${
              uploadDragActive
                ? `${accent.dragActiveBorder} ${accent.dragActiveBg}`
                : 'border-border bg-muted/20 hover:bg-muted/40'
            }`}
          >
            <Upload size={22} className={uploadDragActive ? accent.dragActiveIcon : 'text-muted-foreground'} />
            <div className="text-left">
              <p className="text-[12px] font-semibold text-foreground">Drag &amp; drop your Excel file here</p>
              <p className="text-[11px] text-muted-foreground">or click to browse</p>
            </div>
            <input
              ref={uploadFileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(event) => handleUploadFileSelected(event.target.files?.[0])}
            />
          </div>
        ) : (
          <div className="mt-4 flex h-[72px] items-center gap-3 rounded-xl border border-border bg-muted/20 p-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
              <FileSpreadsheet size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-foreground">{uploadedFile.name}</p>
              <p className="text-[11px] text-muted-foreground">{(uploadedFile.size / 1024).toFixed(0)} KB</p>
            </div>
            {uploadStatus !== 'importing' && (
              <button
                type="button"
                onClick={resetUploadState}
                aria-label="Remove file"
                className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}

        {uploadedFile && uploadStatus === 'importing' && (
          <div className="mt-4 rounded-xl border border-border bg-muted/20 p-4">
            <p className="text-[13px] font-semibold text-foreground">Importing data...</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Please wait while we process your file.</p>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all duration-300 ${accent.progressBarFill}`}
                style={{ width: `${Math.min(uploadProgress, 100)}%` }}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">This may take a few seconds.</p>
              <p className="text-[11px] font-semibold tabular-nums text-foreground">{Math.round(Math.min(uploadProgress, 100))}%</p>
            </div>
          </div>
        )}

        {uploadedFile && uploadStatus === 'success' && importResult && (
          <>
            <div className="mt-4 rounded-xl bg-emerald-50 p-5 text-center dark:bg-emerald-500/10">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-emerald-600 text-white">
                <CheckCircle2 size={22} />
              </div>
              <p className="mt-3 text-[14px] font-bold text-foreground">Opening Balance imported successfully!</p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">{importResult.shopCount} shops imported.</p>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <FileText size={12} className="shrink-0" />
                  File Name
                </p>
                <p className="mt-1 truncate text-[12px] font-medium text-foreground">{importResult.fileName}</p>
              </div>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <User size={12} className="shrink-0" />
                  Imported By
                </p>
                <p className="mt-1 truncate text-[12px] font-medium text-foreground">{importResult.importedBy}</p>
              </div>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Clock size={12} className="shrink-0" />
                  Imported At
                </p>
                <p className="mt-1 truncate text-[12px] font-medium text-foreground">{formatImportTimestamp(importResult.importedAt)}</p>
              </div>
            </div>

            {lastImport && (
              <div className="mt-4 border-t border-border pt-3">
                <p className="text-[11px] font-semibold text-muted-foreground">Last Import</p>
                <LastImportRow record={lastImport} highlighted highlightedRowBg={accent.highlightedRowBg} />
              </div>
            )}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={handleImportDone}
                className={`rounded-lg px-5 py-2 text-[12px] font-semibold text-white transition-colors ${accent.primaryButton}`}
              >
                Done
              </button>
            </div>
          </>
        )}

        {uploadedFile && uploadStatus !== 'importing' && !(uploadStatus === 'success' && importResult) && (
          <>
            <p className="mt-4 text-[11px] font-semibold text-muted-foreground">Detected</p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <div className="flex items-center gap-2 rounded-xl border border-border p-2.5">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${accent.shopBadgeBg} ${accent.shopBadgeText}`}>
                  <Store size={14} />
                </div>
                <div className="min-w-0">
                  <p className="text-[15px] font-bold tabular-nums text-foreground">{uploadDetectedShops.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground">Shops</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-border p-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                  <CheckCircle2 size={14} />
                </div>
                <div className="min-w-0">
                  <p className="text-[15px] font-bold tabular-nums text-foreground">{(uploadDetectedShops - uploadDetectedErrors).toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground">Imported Successfully</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { if (uploadDetectedErrors > 0) setUploadErrorsExpanded((v) => !v); }}
                disabled={uploadDetectedErrors === 0}
                className={`flex items-center gap-2 rounded-xl border border-border p-2.5 text-left transition-colors ${
                  uploadDetectedErrors > 0 ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default'
                }`}
              >
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  uploadDetectedErrors === 0
                    ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                    : 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
                }`}>
                  {uploadDetectedErrors === 0 ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-bold tabular-nums text-foreground">{uploadDetectedErrors}</p>
                  <p className="text-[10px] text-muted-foreground">Errors</p>
                </div>
                {uploadDetectedErrors > 0 && (
                  uploadErrorsExpanded
                    ? <ChevronUp size={13} className="shrink-0 text-muted-foreground" />
                    : <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
                )}
              </button>
            </div>

            {uploadDetectedErrors > 0 && uploadErrorsExpanded && (
              <div className="mt-3 overflow-hidden rounded-xl border border-border">
                <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">
                    The following rows were skipped during import because of validation errors.
                  </p>
                  <button
                    type="button"
                    onClick={downloadErrorReport}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <Download size={11} />
                    Download Error Report (.xlsx)
                  </button>
                </div>
                <div className="max-h-[320px] overflow-y-auto">
                  <table className="w-full border-collapse text-[10px]">
                    <thead className="sticky top-0 z-10 bg-white dark:bg-[#2a2a2d]">
                      <tr className="border-b border-border">
                        <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Row</th>
                        <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Shop Code</th>
                        <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Shop Name</th>
                        <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Column</th>
                        <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Invalid Value</th>
                        <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-muted-foreground">Error Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {uploadRowErrors.map((e, i) => (
                        <tr key={`${e.row}-${e.column}-${i}`} className="border-b border-border last:border-0">
                          <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-foreground">{e.row}</td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-foreground">{e.shopCode}</td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-foreground">{e.shopName}</td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-muted-foreground">{e.column}</td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-rose-600 dark:text-rose-400">{e.value || '(blank)'}</td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-muted-foreground">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {uploadParsed && uploadDetectedErrors === 0 && (
              <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                <CheckCircle2 size={13} className="shrink-0" />
                All data imported successfully. No validation errors found.
              </div>
            )}

            {uploadStatus === 'error' && uploadError && (
              <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-400">
                <AlertCircle size={13} className="shrink-0" />
                {uploadError}
              </div>
            )}
          </>
        )}

        {/* Last Import — visible as soon as the modal opens, regardless
            of whether a file has been picked yet, so it's always there
            as proof of when this was last done. Hidden only in the
            success view above, which shows its own updated copy. */}
        {lastImport && !(uploadedFile && uploadStatus === 'success' && importResult) && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-[11px] font-semibold text-muted-foreground">Last Import</p>
            <LastImportRow record={lastImport} highlightedRowBg={accent.highlightedRowBg} />
          </div>
        )}

        {uploadedFile && uploadStatus !== 'importing' && !(uploadStatus === 'success' && importResult) && (
          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={closeUploadModal}
              className="rounded-lg border border-border px-4 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleImportData}
              disabled={!uploadParsed || uploadDetectedShops === 0}
              className={`rounded-lg px-4 py-2 text-[12px] font-semibold text-white transition-colors disabled:opacity-50 ${accent.primaryButton}`}
            >
              Import Data
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
