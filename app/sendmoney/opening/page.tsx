'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Search, Filter, ChevronUp, ChevronDown, Download, Upload, X, FileSpreadsheet, CheckCircle2, AlertCircle, Store, FileText, User, Clock } from 'lucide-react';
import * as XLSX from 'xlsx';
import ThemeToggle from '@/app/components/ThemeToggle';
import ConnectionErrorState from '@/app/components/ConnectionErrorState';
import { classifyFetchError, type ClassifiedError } from '@/app/lib/errors';
import { parseSendMoneyOpeningCsv, type SendMoneyOpeningRow } from '@/app/lib/sendMoneyOpening';
import { extractSendMoneyShopName } from '@/app/lib/realShopName';
import { fromManilaWallClockMs } from '@/app/lib/businessDate';
import { isValidNumericCell } from '@/app/lib/uploadValidation';

type ImportRecord = { fileName: string; shopCount: number; importedAt: string; importedBy: string };

// One row skipped during the upload preview's own validation — mirrors
// exactly what app/lib/estimatedOpening.ts's aggregateByShop skips
// server-side (see its own isValidNumericCell check), so the preview never
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
// Import/Import Success UI (separate from the sheet's own "Last Updated"
// cell format, which is untouched). Explicit Asia/Manila timeZone so this
// always reads as the business's own time, regardless of the viewer's own
// device/browser timezone.
function formatImportTimestamp(serverTimestamp: string): string {
  const date = parseServerTimestamp(serverTimestamp);
  if (!date) return serverTimestamp;
  const datePart = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' });
  const timePart = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' });
  return `${datePart} ${timePart}`;
}

// Shown as soon as the upload modal opens (not gated behind picking a file)
// so there's always visible proof of when this was last done, from any
// device — see the SEND MONEY block in app/lib/estimatedOpening.ts.
function LastImportRow({ record, highlighted }: { record: ImportRecord; highlighted?: boolean }) {
  return (
    <div className={`mt-2 flex items-center justify-between gap-2 rounded-xl p-2.5 ${highlighted ? 'bg-[color:var(--product-accent-soft)]' : ''}`}>
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

// Zero and "not set" (blank/null source cell) both render as the same dash —
// visually identical to Cashout's fmt(), but null stays a distinct value
// upstream (see app/lib/sendMoneyOpening.ts) for counts/sums that need to
// tell "no opening balance" apart from "opening balance of exactly 0".
function fmt(value: number | null): string {
  if (value === null || value === 0) return '—';
  return Math.abs(value).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type ColumnKey = 'brand' | 'leader' | 'agentName' | 'openingBalance' | 'securityDeposit';
type SortColumn = '' | ColumnKey;

const columns: { key: ColumnKey; label: string }[] = [
  { key: 'brand', label: 'Brand' },
  { key: 'leader', label: 'Leader' },
  { key: 'agentName', label: 'Agent Name' },
  { key: 'openingBalance', label: 'Opening Balance' },
  { key: 'securityDeposit', label: 'Security Deposit' },
];

const columnWidths: Record<ColumnKey, string> = {
  brand: '18%',
  leader: '20%',
  agentName: '22%',
  openingBalance: '20%',
  securityDeposit: '20%',
};

function headerCellClasses() {
  return 'group text-center px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] whitespace-nowrap text-muted-foreground';
}

function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  if (!active) {
    return (
      <span className="flex flex-col items-center justify-center leading-none text-slate-400 opacity-0 transition-opacity duration-150 group-hover:opacity-40">
        <ChevronUp size={10} className="-mb-0.5" />
        <ChevronDown size={10} />
      </span>
    );
  }
  return direction === 'asc' ? (
    <ChevronUp size={10} className="text-[color:var(--product-accent)]" />
  ) : (
    <ChevronDown size={10} className="text-[color:var(--product-accent)]" />
  );
}

function renderCell(row: SendMoneyOpeningRow, key: ColumnKey) {
  const base = 'whitespace-nowrap overflow-hidden text-ellipsis px-3 py-1.5 text-center text-[11px]';
  switch (key) {
    case 'brand':
      return <td key={key} className={`${base} text-muted-foreground`}>{row.brand ?? '—'}</td>;
    case 'leader':
      return <td key={key} className={`${base} text-muted-foreground`}>{row.leader}</td>;
    case 'agentName':
      return <td key={key} className={`${base} font-semibold text-foreground`}>{row.agentName}</td>;
    case 'openingBalance':
      return <td key={key} className={`${base} tabular-nums text-foreground`}>{fmt(row.openingBalance)}</td>;
    case 'securityDeposit':
      return <td key={key} className={`${base} tabular-nums text-foreground`}>{fmt(row.securityDeposit)}</td>;
    default:
      return null;
  }
}

function compareNullableNumber(a: number | null, b: number | null, direction: 'asc' | 'desc'): number {
  // Nulls always sort last, regardless of direction.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'asc' ? a - b : b - a;
}

export default function SendMoneyOpeningPage() {
  const [rows, setRows] = useState<SendMoneyOpeningRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [brandFilter, setBrandFilter] = useState<Record<string, boolean>>({});
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [leaderFilter, setLeaderFilter] = useState<Record<string, boolean>>({});
  const [leaderMenuOpen, setLeaderMenuOpen] = useState(false);
  const [sortColumn, setSortColumn] = useState<SortColumn>('leader');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [filterMenuPos, setFilterMenuPos] = useState({ top: 0, left: 0 });
  const [columnVisibility, setColumnVisibility] = useState<Record<ColumnKey, boolean>>(
    () => Object.fromEntries(columns.map((col) => [col.key, true])) as Record<ColumnKey, boolean>
  );
  const rowsPerPage = 50;

  // Next-day "assumed balance" upload — same feature as Cashout's own
  // Opening page (app/summary/page.tsx), writing into the same "Estimated
  // Opening" sheet tab's reserved Send Money column block instead of a
  // separate sheet. See app/lib/estimatedOpening.ts for the write/read logic.
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
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
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandDropdownRef = useRef<HTMLDivElement>(null);
  const leaderButtonRef = useRef<HTMLButtonElement>(null);
  const leaderDropdownRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    // Refresh always stays visibly "loading" for at least this long, even if
    // the fetch itself is too fast to notice — otherwise a quick response
    // reads as "nothing happened." Never caps a slow fetch, only pads a fast
    // one up to this floor.
    const MIN_SPIN_MS = 600;
    const startedAt = Date.now();
    try {
      setSpinning(true);
      setLoading(true);
      setError(null);
      setRows([]);
      const res = await fetch(`/api/sendmoney/opening?t=${Date.now()}`);
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Request failed with status ${res.status}`);
      const text = await res.text();
      setRows(parseSendMoneyOpeningCsv(text));
    } catch (err) {
      setError(classifyFetchError(err instanceof Error ? err.message : String(err)));
    } finally {
      const remaining = MIN_SPIN_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      setLoading(false);
      setSpinning(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    setPage(1);
  }, [searchTerm, brandFilter, leaderFilter, sortColumn, sortDirection]);

  useEffect(() => {
    if (!brandMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        brandButtonRef.current && !brandButtonRef.current.contains(target) &&
        brandDropdownRef.current && !brandDropdownRef.current.contains(target)
      ) {
        setBrandMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [brandMenuOpen]);

  useEffect(() => {
    if (!leaderMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        leaderButtonRef.current && !leaderButtonRef.current.contains(target) &&
        leaderDropdownRef.current && !leaderDropdownRef.current.contains(target)
      ) {
        setLeaderMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [leaderMenuOpen]);

  useEffect(() => {
    if (!filterMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        filterButtonRef.current && !filterButtonRef.current.contains(target) &&
        filterDropdownRef.current && !filterDropdownRef.current.contains(target)
      ) {
        setFilterMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [filterMenuOpen]);

  const visibleColumns = useMemo(() => columns.filter((col) => columnVisibility[col.key]), [columnVisibility]);
  const allColumnsChecked = columns.every((col) => columnVisibility[col.key]);
  const anyColumnHidden = columns.some((col) => !columnVisibility[col.key]);
  const anyFilterActive = anyColumnHidden;

  const brandOptions = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.brand).filter((b): b is string => b !== null))).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const isBrandChecked = (name: string) => brandFilter[name] !== false;
  const allBrandsChecked = brandOptions.every((name) => isBrandChecked(name));
  const anyBrandUnchecked = brandOptions.some((name) => !isBrandChecked(name));
  const selectedBrandCount = brandOptions.filter((name) => isBrandChecked(name)).length;

  const leaderOptions = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.leader).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const isLeaderChecked = (name: string) => leaderFilter[name] !== false;
  const allLeadersChecked = leaderOptions.every((name) => isLeaderChecked(name));
  const anyLeaderUnchecked = leaderOptions.some((name) => !isLeaderChecked(name));
  const selectedLeaderCount = leaderOptions.filter((name) => isLeaderChecked(name)).length;

  const searchedRows = rows.filter((row) => {
    const haystack = `${row.leader} ${row.agentName} ${fmt(row.openingBalance)} ${fmt(row.securityDeposit)}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  const brandedRows = brandOptions.some((name) => brandFilter[name] === false)
    ? searchedRows.filter((row) => row.brand !== null && brandFilter[row.brand] !== false)
    : searchedRows;

  const filteredRows = leaderOptions.some((name) => leaderFilter[name] === false)
    ? brandedRows.filter((row) => leaderFilter[row.leader] !== false)
    : brandedRows;

  const sortedRows = useMemo(() => {
    if (!sortColumn) return filteredRows;
    const list = [...filteredRows];
    list.sort((a, b) => {
      if (sortColumn === 'openingBalance' || sortColumn === 'securityDeposit') {
        return compareNullableNumber(a[sortColumn], b[sortColumn], sortDirection);
      }
      const getValue = (row: SendMoneyOpeningRow) => {
        switch (sortColumn) {
          case 'brand':
            return (row.brand ?? '').toLowerCase();
          case 'leader':
            return row.leader.toLowerCase();
          case 'agentName':
            return row.agentName.toLowerCase();
          default:
            return '';
        }
      };
      const comparison = getValue(a).localeCompare(getValue(b));
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [filteredRows, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const pagedRows = sortedRows.slice(startIndex, endIndex);

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  const handleExport = useCallback(() => {
    const getExportValue = (row: SendMoneyOpeningRow, key: ColumnKey) => {
      switch (key) {
        case 'brand':
          return row.brand ?? '—';
        case 'leader':
          return row.leader;
        case 'agentName':
          return row.agentName;
        case 'openingBalance':
          return fmt(row.openingBalance);
        case 'securityDeposit':
          return fmt(row.securityDeposit);
        default:
          return '';
      }
    };

    const headers = visibleColumns.map((col) => col.label);
    const data = sortedRows.map((row) => visibleColumns.map((col) => getExportValue(row, col.key)));

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 16 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Opening Balance');

    const now = new Date();
    const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `SENDMONEY_OPENING_BALANCE_${datePart}_${timePart}.xlsx`);
  }, [sortedRows, visibleColumns]);

  const openUploadModal = useCallback(() => {
    setUploadModalOpen(true);
    fetch(`/api/sendmoney/opening/estimated-balance?t=${Date.now()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { lastImport: ImportRecord | null } | null) => {
        if (data?.lastImport) setLastImport(data.lastImport);
      })
      .catch(() => {
        // Couldn't reach the server — just skip showing Last Import rather
        // than blocking the modal from opening.
      });
  }, []);

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
    setUploadModalOpen(false);
    setUploadDragActive(false);
    resetUploadState();
  }, [resetUploadState]);

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
      // (same extractSendMoneyShopName, same "OLD" exclusion, same
      // numeric-cell check) so a row flagged as an error here is actually
      // excluded at import time too, not silently included with a wrong
      // total. Send Money's own shop-name formula (everything after " - ")
      // is different from Cashout's own brand-suffix based one.
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
        const shopName = extractSendMoneyShopName(rawAccount);

        if (!shopName) {
          errorRowNumbers.add(rowNumber);
          rowErrors.push({
            row: rowNumber, shopCode, shopName: '—', column: 'Account',
            value: String(rawAccount ?? ''), message: 'Missing or invalid shop code',
          });
          return;
        }
        if (shopName === 'OLD') return;

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
  }, []);

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
      const res = await fetch('/api/sendmoney/opening/upload-estimated-balance', {
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
  }, [uploadedFile, uploadParsed]);

  const handleImportDone = useCallback(() => {
    setUploadModalOpen(false);
    setUploadDragActive(false);
    resetUploadState();
    fetchData();
  }, [resetUploadState, fetchData]);

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-background font-[Inter,sans-serif] text-foreground transition-colors duration-300 dark:bg-[#1c1c1e]">
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-white/95 py-0 pl-14 pr-4 backdrop-blur-sm dark:bg-[#0d1117]/95 md:px-8">
        <div className="flex h-12 items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-4 w-[3px] rounded-full bg-[color:var(--product-accent)]" />
            <h1 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">Opening Balance</h1>
            <span className="rounded-full bg-[color:var(--product-accent-soft)] px-2 py-0.5 text-[9px] font-semibold text-[color:var(--product-accent)]">
              Send Money
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              onClick={fetchData}
              disabled={spinning || loading}
              aria-label="Refresh"
              title="Refresh"
              className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw size={11} className={spinning ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden px-6 pt-4 pb-6">

        {error && <ConnectionErrorState error={error} onRetry={fetchData} />}

        {!error && (
          <div className="flex-1 flex flex-col min-h-0 mt-3 bg-white rounded-xl border border-border overflow-hidden dark:bg-[#2a2a2d]">
            <div className="shrink-0 px-3 py-2 border-b border-border bg-muted/20 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {loading ? (
                  <div className="h-5 w-28 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                ) : (
                  <div className="flex items-center gap-1.5 rounded-md bg-[color:var(--product-accent-soft)] px-2.5 py-1">
                    <span className="text-[10px] font-medium text-[color:var(--product-accent)]">Accounts</span>
                    <span className="text-[11px] font-bold tabular-nums text-[color:var(--product-accent)]">{sortedRows.length.toLocaleString('en-PH')}</span>
                  </div>
                )}
                <div className="flex w-full min-w-[140px] flex-1 items-center gap-2 rounded-lg border border-border bg-white px-3 py-1.5 dark:bg-[#2a2a2d] sm:w-52 sm:flex-none">
                  {loading ? (
                    <div className="h-3 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                  ) : (
                    <>
                      <Search size={13} className="shrink-0 text-muted-foreground" />
                      <input
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        className="flex-1 bg-transparent text-[10px] text-foreground placeholder:text-muted-foreground outline-none border-none"
                        placeholder="Search agents or brands..."
                      />
                    </>
                  )}
                </div>
                <div className="relative">
                  {!loading && (
                    <button
                      type="button"
                      ref={filterButtonRef}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = filterButtonRef.current?.getBoundingClientRect();
                        if (rect) {
                          const dropdownWidth = 224;
                          const left = Math.min(rect.left, window.innerWidth - dropdownWidth - 8);
                          setFilterMenuPos({ top: rect.bottom + 8, left: Math.max(8, left) });
                        }
                        setFilterMenuOpen((current) => !current);
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium border rounded-lg hover:bg-white transition-colors ${anyFilterActive ? 'border-[color:var(--product-accent)] text-[color:var(--product-accent)]' : 'border-border text-foreground'}`}
                    >
                      <Filter size={14} />
                      Filter
                    </button>
                  )}
                  {filterMenuOpen && typeof document !== 'undefined' && createPortal(
                    <div
                      ref={filterDropdownRef}
                      style={{ position: 'fixed', top: filterMenuPos.top, left: filterMenuPos.left }}
                      className="z-[9999] w-56 max-h-[70vh] overflow-y-auto rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Columns</div>
                      <label className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                        <input
                          type="checkbox"
                          checked={allColumnsChecked}
                          onChange={() => {
                            const nextValue = !allColumnsChecked;
                            setColumnVisibility(
                              Object.fromEntries(columns.map((col) => [col.key, nextValue])) as Record<ColumnKey, boolean>
                            );
                          }}
                        />
                        <span>Check All</span>
                      </label>
                      {columns.map((col) => (
                        <label key={col.key} className="flex w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                          <input
                            type="checkbox"
                            checked={columnVisibility[col.key]}
                            onChange={() => {
                              setColumnVisibility((current) => ({ ...current, [col.key]: !current[col.key] }));
                            }}
                          />
                          <span>{col.label}</span>
                        </label>
                      ))}
                    </div>,
                    document.body
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {loading ? (
                  <div className="h-6 w-32 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] tabular-nums text-muted-foreground">{currentPage} / {totalPages}</span>
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                      disabled={currentPage === 1}
                      className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-[10px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40 dark:bg-transparent"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                      disabled={currentPage === totalPages}
                      className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-[10px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40 dark:bg-transparent"
                    >
                      Next
                    </button>
                  </div>
                )}
                {loading && <div className="h-7 w-20 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700" />}
                {!loading && (
                  <button
                    type="button"
                    onClick={openUploadModal}
                    title="Upload Excel Data"
                    className="rounded-lg border border-border bg-white p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:bg-transparent"
                  >
                    <Upload size={13} />
                  </button>
                )}
                {!loading && (
                  <button
                    type="button"
                    onClick={handleExport}
                    title="Export to Excel"
                    className="rounded-lg border border-border bg-white p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:bg-transparent"
                  >
                    <Download size={13} />
                  </button>
                )}
              </div>
            </div>
            <div className="hidden relative flex-1 min-h-0 overflow-y-auto overflow-x-auto sm:block">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  {visibleColumns.map((col) => (
                    <col key={col.key} style={{ width: columnWidths[col.key] }} />
                  ))}
                </colgroup>
                <thead className="sticky top-0 z-[50] bg-white dark:bg-[#252528] border-b border-border shadow-[0_1px_3px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.35)]">
                  <tr>
                    {visibleColumns.map((col) => (
                      <th
                        key={col.key}
                        style={{ width: columnWidths[col.key] }}
                        className={headerCellClasses()}>
                        {loading ? (
                          <div className="mx-auto h-5 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        ) : col.key === 'brand' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <span>{col.label}</span>
                            <button
                              type="button"
                              ref={brandButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                setBrandMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyBrandUnchecked ? 'bg-[color:var(--product-accent-soft)] text-[color:var(--product-accent)]' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              {anyBrandUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedBrandCount}
                                </span>
                              ) : (
                                <ChevronUp
                                  size={12}
                                  className={`transition-transform duration-150 ease-in-out ${brandMenuOpen ? 'rotate-180' : ''} opacity-70`}
                                />
                              )}
                            </button>
                            {brandMenuOpen && (
                              <div
                                ref={brandDropdownRef}
                                className="absolute top-full left-0 mt-1 z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Brand</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allBrandsChecked}
                                      onChange={() => {
                                        const nextValue = !allBrandsChecked;
                                        setBrandFilter(
                                          Object.fromEntries(brandOptions.map((name) => [name, nextValue]))
                                        );
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {brandOptions.map((brand) => (
                                    <label key={brand} className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={isBrandChecked(brand)}
                                        onChange={() => {
                                          setBrandFilter((current) => ({ ...current, [brand]: !isBrandChecked(brand) }));
                                        }}
                                      />
                                      <span>{brand}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : col.key === 'leader' ? (
                          <div className="relative flex items-center justify-center gap-1">
                            <span>{col.label}</span>
                            <button
                              type="button"
                              ref={leaderButtonRef}
                              onClick={(event) => {
                                event.stopPropagation();
                                setLeaderMenuOpen((current) => !current);
                              }}
                              className={`flex items-center justify-center rounded-full p-1 transition ${anyLeaderUnchecked ? 'bg-[color:var(--product-accent-soft)] text-[color:var(--product-accent)]' : 'text-[#6b7280] hover:bg-slate-200 dark:text-[#a0a0a0] dark:hover:bg-white/10'}`}
                            >
                              {anyLeaderUnchecked ? (
                                <span className="flex h-3 min-w-[12px] items-center justify-center px-0.5 text-[10px] font-semibold leading-none">
                                  {selectedLeaderCount}
                                </span>
                              ) : (
                                <ChevronUp
                                  size={12}
                                  className={`transition-transform duration-150 ease-in-out ${leaderMenuOpen ? 'rotate-180' : ''} opacity-70`}
                                />
                              )}
                            </button>
                            {leaderMenuOpen && (
                              <div
                                ref={leaderDropdownRef}
                                className="absolute top-full left-0 mt-1 z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-2 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6b7280] dark:text-[#a0a0a0]">Leader</div>
                                <div className="max-h-56 overflow-y-auto">
                                  <label className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                    <input
                                      type="checkbox"
                                      checked={allLeadersChecked}
                                      onChange={() => {
                                        const nextValue = !allLeadersChecked;
                                        setLeaderFilter(
                                          Object.fromEntries(leaderOptions.map((name) => [name, nextValue]))
                                        );
                                      }}
                                    />
                                    <span>All</span>
                                  </label>
                                  {leaderOptions.map((leader) => (
                                    <label key={leader} className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-center text-[10px] text-[#6b7280] hover:bg-[#f5f5f7] dark:text-[#a0a0a0] dark:hover:bg-slate-800">
                                      <input
                                        type="checkbox"
                                        checked={isLeaderChecked(leader)}
                                        onChange={() => {
                                          setLeaderFilter((current) => ({ ...current, [leader]: !isLeaderChecked(leader) }));
                                        }}
                                      />
                                      <span>{leader}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              if (sortColumn === col.key) {
                                setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
                              } else {
                                setSortColumn(col.key);
                                setSortDirection('asc');
                              }
                            }}
                            className="flex w-full items-center justify-center gap-1.5 text-center transition hover:opacity-80"
                          >
                            <span>{col.label}</span>
                            <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                          </button>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? Array.from({ length: 18 }).map((_, i) => (
                    <tr key={i}>
                      {visibleColumns.map((col) => (
                        <td key={col.key} className="px-3 py-1.5">
                          <div className="mx-auto h-2.5 w-3/4 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                        </td>
                      ))}
                    </tr>
                  )) : pagedRows.length > 0 ? pagedRows.map((row, i) => (
                    <tr key={row.agentName || i} className={`border-b border-border last:border-0 transition-colors hover:bg-muted/10 ${i % 2 === 1 ? 'bg-muted/5' : ''}`}>
                      {visibleColumns.map((col) => renderCell(row, col.key))}
                    </tr>
                  )) : <tr><td colSpan={visibleColumns.length} className="px-3 py-8 text-center text-[11px] text-muted-foreground">No matching agents found.</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto sm:hidden">
              <div className="flex flex-col gap-2 p-3">
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="rounded-xl border border-border bg-white p-3.5 dark:bg-[#2a2a2d]">
                      <div className="h-4 w-2/3 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="mt-2 h-3 w-1/3 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                      <div className="mt-3 h-6 w-1/2 animate-pulse rounded-md bg-slate-200 dark:bg-slate-700" />
                    </div>
                  ))
                ) : pagedRows.length > 0 ? (
                  pagedRows.map((row, i) => (
                    <div key={row.agentName || i} className="rounded-xl border border-border bg-white p-3.5 dark:bg-[#2a2a2d]">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-foreground">{row.agentName}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{row.leader}{row.brand ? ` · ${row.brand}` : ''}</p>
                        </div>
                      </div>

                      <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-border pt-2.5">
                        <div>
                          <p className="text-[9px] font-medium text-muted-foreground">Opening Balance</p>
                          <p className="text-sm font-bold tabular-nums text-foreground">{fmt(row.openingBalance)}</p>
                        </div>
                        <div>
                          <p className="text-[9px] font-medium text-muted-foreground">Security Deposit</p>
                          <p className="text-sm font-bold tabular-nums text-foreground">{fmt(row.securityDeposit)}</p>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="px-3 py-8 text-center text-[11px] text-muted-foreground">
                    No matching agents found.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {uploadModalOpen && typeof document !== 'undefined' && createPortal(
        <div
          data-product="sendmoney"
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
                    ? 'border-[color:var(--product-accent)] bg-[color:var(--product-accent-soft)]'
                    : 'border-border bg-muted/20 hover:bg-muted/40'
                }`}
              >
                <Upload size={22} className={uploadDragActive ? 'text-[color:var(--product-accent)]' : 'text-muted-foreground'} />
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
                    className="h-full rounded-full bg-[color:var(--product-accent)] transition-all duration-300"
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
                    <LastImportRow record={lastImport} highlighted />
                  </div>
                )}

                <div className="mt-5 flex justify-end">
                  <button
                    type="button"
                    onClick={handleImportDone}
                    className="rounded-lg bg-[color:var(--product-accent)] px-5 py-2 text-[12px] font-semibold text-white transition-colors hover:opacity-90"
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
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[color:var(--product-accent-soft)] text-[color:var(--product-accent)]">
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
                <LastImportRow record={lastImport} />
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
                  className="rounded-lg bg-[color:var(--product-accent)] px-4 py-2 text-[12px] font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  Import Data
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
