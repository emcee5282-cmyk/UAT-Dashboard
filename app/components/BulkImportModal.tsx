'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Upload, X, FileSpreadsheet, Download, CheckCircle2, AlertCircle, AlertTriangle, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Pencil, Check, SkipForward,
  Store, User, Clock, FileText, Wallet, RefreshCw, Copy, UserX, CalendarClock, Tag, MessageSquare,
  UserPlus, UserMinus, Layers, ListChecks,
} from 'lucide-react';
import {
  MODAL_OVERLAY_CLASS,
  MODAL_WIDE_CARD_CLASS,
  MODAL_GLYPH_CLASS,
  MODAL_GLYPH_STYLE,
  MODAL_CLOSE_BUTTON_CLASS,
  MODAL_GHOST_BUTTON_CLASS,
  MODAL_PRIMARY_BUTTON_SHAPE_CLASS,
} from './modalTheme';
import * as XLSX from 'xlsx';
import { downloadTemplate, type TemplateModule } from '../lib/templates';
import { displayNum, parseAmount } from '../lib/format';
import { parseWorkbookFile, mapSettlementRows, mapTopUpRows, mapOpeningRows, type SettlementImportRow, type TopUpImportRow, type OpeningImportRow } from '../lib/xlsxParser';
import {
  validateSettlementRows, checkBrandField, checkAgentNameField, checkWalletField, checkAmountField, checkDateField, parseImportDate,
  type ValidationEntry, type ValidationConfig,
} from '../lib/settlementValidation';
import { getBusinessToday, manilaFields, formatManilaClockTime } from '../lib/businessDate';
import { validateTopUpRows, checkTypeField, type TopUpValidationConfig } from '../lib/topupValidation';
import { validateOpeningRows, checkOptionalAmountField, checkAgentNameFormat, checkAgentNameRequired, type OpeningValidationConfig } from '../lib/openingValidation';
import { detectDuplicatesWithinFile, detectDuplicateAgentNames, detectAlreadyImportedDuplicates } from '../lib/duplicateDetector';
import type { ExistingTransactionSignature } from '../lib/services/transactionPageService';
import { calculateImportSummary, calculateOpeningImportSummary, type ImportSummary } from '../lib/importSummary';
import { mockImportRecords } from '../lib/importService';
import { parseEstimateRows, formatImportTimestamp, type EstimateImportRecord, type EstimateRowError } from '../lib/estimateUpload';
import type { RecordFormField } from './RecordFormModal';
import RowIssueEditModal from './RowIssueEditModal';
import SearchableCombobox from './SearchableCombobox';
import EstimateLastImportRow from './EstimateLastImportRow';

// A single wizard implementation serves Settlement's row shape
// (brand/agentName/wallet/amount/remarks/date), Top Up's
// (brand/agentName/wallet/amount/type/date), and Opening Balance's
// (agentName/leader/openingBalance/sdp — no brand/wallet/date at all,
// branched on `moduleKind`. Every field is optional here since each
// concrete parse (mapSettlementRows/mapTopUpRows/mapOpeningRows) only ever
// populates the subset its own module actually has; the moduleKind-aware
// helpers below cast back to the concrete type wherever a function needs a
// real guarantee (validate/summary calls). Every step-rendering/error-
// table/report piece below only reads row/agentName or goes through those
// helpers — nothing about the wizard UI itself changes per module.
type ImportRow = {
  row: number;
  agentName: string;
  brand?: string;
  wallet?: string;
  amount?: string;
  date?: string;
  remarks?: string;
  type?: string;
  leader?: string;
  openingBalance?: string;
  sdp?: string;
};

// Opening's daily-upload New Shops confirmation — mirrors
// importService.ts's own NewShopDecision exactly (kept as a separate type
// here rather than imported, since importService.ts is server-only code and
// this file is 'use client'; the two are kept in sync by hand, same as
// every other client/server shape pair in this file).
type NewShopDecision =
  | { action: 'insert'; leader: string }
  | { action: 'link'; agentCode: string };

// Minimal shape pulled from GET /api/v2/opening or /api/v2/sendmoney/opening
// (openingPageService.ts's CashoutOpeningRow/SendMoneyOpeningPgRow) — used
// for New Shops matching/Leader suggestions (agentCode/leader), the
// SDP-change comparison (sdp — null means "no previous value", same as the
// roster's own read side; the check is skipped entirely then, per spec),
// and (Phase 3) Missing Shops' own "Last updated" display. The two source
// shapes differ in field names (sdp vs securityDeposit) — normalized to
// this one shape at fetch time.
type OpeningRosterEntry = { agentCode: string; leader: string; sdp: number | null; lastImportMatchedAt: string | null };

// SDP change confirmation (Phase 2) — a starting-point threshold, per the
// user's own caveat; retune here if it proves too/not sensitive once
// exercised against real day-to-day SDP fluctuations.
const SDP_CHANGE_THRESHOLD = 0.5;

const TEMPLATE_LABEL: Record<TemplateModule, string> = {
  settlement: 'Settlement',
  topup: 'Top Up',
  openingCashout: 'Opening Balance (Cashout)',
  openingSendMoney: 'Opening Balance (Send Money)',
  balanceLimitCashout: 'Balance Limit (Cashout)',
  balanceLimitSendMoney: 'Balance Limit (Send Money)',
};

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

// See startImportProgress's own comment — the simulated import progress
// bar's tick step is derived from these so it reaches its 90% cap in
// roughly this real-world duration regardless of file size.
const IMPORT_PROGRESS_TICK_MS = 120;
const IMPORT_PROGRESS_TARGET_MS = 3500;

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Maps a ValidationEntry's human-readable `field` (settlementValidation.ts/
// topupValidation.ts/openingValidation.ts's own addIssue calls) to the
// matching RecordFormField `key` RowIssueEditModal actually renders —
// duplicateDetector.ts's own 'Duplicate' field intentionally has no entry
// here (a duplicate highlights all fields via highlightedKeys: 'all', not
// a specific one).
const ISSUE_FIELD_TO_KEY: Record<string, string> = {
  Brand: 'brand',
  'Agent Name': 'agentName',
  'Agent Name Format': 'agentName',
  Wallet: 'wallet',
  Amount: 'amount',
  Date: 'date',
  Type: 'type',
  Remarks: 'remarks',
  'Opening Balance': 'openingBalance',
  SDP: 'sdp',
};

// Short, human label for the Export Errors report's own "Issue" column —
// distinct from ValidationEntry.issue (a full sentence meant for the
// on-screen Issues column). "is required" is the one message shape every
// checkFooField in settlementValidation.ts/topupValidation.ts uses for a
// blank value, so it's the one reliable signal to tell "missing" apart
// from "present but invalid" without a second field on ValidationEntry.
function issueLabel(entry: ValidationEntry): string {
  if (entry.type === 'duplicate') return 'Duplicate';
  const missing = /is required/i.test(entry.issue);
  switch (entry.field) {
    case 'Brand': return missing ? 'Missing Brand' : 'Invalid Brand';
    case 'Agent Name': return missing ? 'Missing Agent Name' : 'Unregistered Agent';
    case 'Agent Name Format': return 'Invalid Agent Name Format';
    case 'Wallet': return missing ? 'Missing Wallet' : 'Invalid Wallet';
    case 'Amount': return missing ? 'Missing Amount' : 'Invalid Amount';
    case 'Date': return missing ? 'Missing Date' : 'Invalid Date';
    case 'Type': return missing ? 'Missing Type' : 'Invalid Type';
    case 'Remarks': return 'Unrecognized Remarks';
    case 'Opening Balance': return 'Invalid Opening Balance';
    case 'SDP': return 'Invalid SDP';
    default: return entry.field;
  }
}

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

// Normalizes a row's raw uploaded date string to 'YYYY-MM-DD' — the shape
// wallet_transactions.occurred_on is stored in, and what the already-
// imported duplicate check (runValidation, the scanning step's distinct-
// dates extraction) both compare against. null for an unparseable date
// (already flagged elsewhere via checkDateField — nothing to compare here).
// Constructed and read back via the same LOCAL getters (parseImportDate's
// "M/D/YYYY" branch builds a local-timezone Date) — a self-consistent
// round trip, unlike mixing local getters with a Manila-anchored Date
// elsewhere in this app.
function toDateKey(rawDate: string | undefined): string | null {
  const parsed = parseImportDate((rawDate ?? '').trim());
  if (!parsed) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
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

// Divides the Ready to Import review step into "Data Issues" (Errors,
// Duplicates, SDP Changes) and "Roster Changes" (New Shops, Missing Shops)
// — icon + small uppercase label + subtitle, matching
// opening_review_sectioned_mockup.jsx exactly. Data Issues gets a divider
// line between the label and subtitle (no trailing action); Roster Changes
// has no divider but pushes a trailing action (Export Roster Changes) to
// the far right instead — both are real, distinct layouts in the
// reference, not a rendering inconsistency.
function ReviewSectionHeader({ icon: Icon, label, subtitle, trailing }: { icon: typeof AlertTriangle; label: string; subtitle: string; trailing?: React.ReactNode }) {
  return (
    <div className="mb-2.5 mt-5 flex items-center justify-between gap-2 first:mt-0">
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={14} className="shrink-0 text-muted-foreground" />
        <h3 className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{label}</h3>
        {!trailing && <div className="h-px w-6 shrink-0 bg-border sm:w-auto sm:flex-1" />}
        <span className="truncate text-[11px] text-muted-foreground">{subtitle}</span>
      </div>
      {trailing}
    </div>
  );
}

// Shared "nothing to flag" banner — used anywhere a check has nothing to
// report (duplicates, date mismatch), instead of that panel just being
// silently omitted, so a clean file gets explicit positive confirmation
// too, not just an absence.
function ClearStatusBanner({ text }: { text: string }) {
  return (
    <div className="mt-2.5 flex items-center gap-2 rounded-[14px] border border-emerald-200 bg-emerald-50/60 px-3 py-2.5 dark:border-emerald-500/20 dark:bg-emerald-500/10">
      <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
      <p className="text-[12px] font-medium text-emerald-700 dark:text-emerald-400">{text}</p>
    </div>
  );
}

// Which icon a specific issue LABEL gets (not just its coarse error/
// duplicate/warning type) — reuses issueLabel()'s own vocabulary (Missing
// Wallet, Invalid Amount, Unregistered Agent, Duplicate, etc.) so the badge
// and the Export Errors spreadsheet always agree on what a given issue is
// called. A plain Record lookup (not a function returning a component) —
// eslint's react-hooks/static-components rule flags resolving which
// component to render via a function call inside render; an object index
// isn't a "component created during render" the same way.
const ISSUE_BADGE_ICONS: Record<string, typeof AlertCircle> = {
  Duplicate: Copy,
  'Missing Brand': Tag,
  'Invalid Brand': Tag,
  'Missing Agent Name': UserX,
  'Unregistered Agent': UserX,
  'Invalid Agent Name Format': UserX,
  'Missing Wallet': Wallet,
  'Invalid Wallet': Wallet,
  'Missing Amount': AlertTriangle,
  'Invalid Amount': AlertTriangle,
  'Missing Date': CalendarClock,
  'Invalid Date': CalendarClock,
  'Missing Type': Tag,
  'Invalid Type': Tag,
  'Unrecognized Remarks': MessageSquare,
  'Invalid Opening Balance': AlertTriangle,
  'Invalid SDP': AlertTriangle,
};

// Unified per-row issue badge — label + icon both derived from the real
// ValidationEntry (via issueLabel()/ISSUE_BADGE_ICONS above), color from
// entry.type (error=rose, duplicate/warning=amber). Used by both the
// Errors panel and the Duplicates panel, and a row carrying more than one
// issue renders one of these per distinct issue, side by side.
function IssueBadge({ entry }: { entry: ValidationEntry }) {
  const label = issueLabel(entry);
  const Icon = ISSUE_BADGE_ICONS[label] ?? AlertCircle;
  const tone = entry.type === 'error'
    ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-400'
    : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400';
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>
      <Icon size={10} className="shrink-0" />
      {label}
    </span>
  );
}

// Distinct from IssueBadge (not tied to a ValidationEntry) — the row-level
// "this row won't be imported because you Skipped it" state.
function SkippedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <SkipForward size={10} className="shrink-0" />
      Skipped
    </span>
  );
}

// Duplicates panel row cards only ever need to show ONE fixed badge
// ("Duplicate") — issueLabel()/issueBadgeIcon() only read entry.type/
// entry.field/entry.issue, none of which vary per row here, so one shared
// object is reused instead of constructing a fresh ValidationEntry inline
// at every call site.
const DUPLICATE_BADGE_ENTRY: ValidationEntry = { row: 0, agent: '', field: 'Duplicate', value: '', issue: 'Duplicate transaction detected.', type: 'duplicate' };

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
  // Settlement's free-text Remarks suggestions (a mismatch is a soft
  // warning) — omit when moduleKind is 'topup'.
  remarksSuggestions?: string[];
  // Top Up's fixed, single-value Type option (a mismatch is a hard error,
  // unlike Remarks) — omit when moduleKind is 'settlement' (the default).
  typeOptions?: string[];
  // Discriminates which parse/validate/field-schema branch this instance
  // uses. Defaults to 'settlement' — every existing Settlement call site
  // omits this prop, so its behavior is byte-identical to before Top Up (and
  // now Opening Balance) reused this component.
  moduleKind?: 'settlement' | 'topup' | 'opening';
  // Opening Balance only — shows an "Estimate Opening Balance" checkbox on
  // the Upload step that swaps the whole wizard onto the real
  // Assumed-Balance pipeline (see estimateApiBasePath below) instead of the
  // mock roster import. Omitted by every Settlement/Top Up call site and by
  // default, so their behavior is untouched.
  allowEstimateMode?: boolean;
  // Appends /estimated-balance (GET, Last Import) and
  // /upload-estimated-balance (POST, real import) — same contract the old
  // standalone UploadExcelModal used. Required when allowEstimateMode is true.
  estimateApiBasePath?: string;
  estimateExtractShopName?: (raw: string | number) => string;
  estimateSkipShopNames?: string[];
  // Phase 7 — Settlement/Top Up's own real-upload switch, same shape as
  // Opening's estimateApiBasePath/moduleKind==='opening' pair but generic
  // over any non-Opening module: when both are set, handleImportStart POSTs
  // the real file to importApiBasePath instead of running mockImportRecords.
  // Omitted by every existing call site (Settlement/Top Up previously never
  // passed these), so their behavior only changes where a caller now
  // explicitly opts in — fully backward compatible.
  importApiBasePath?: string;
  product?: 'cashout' | 'sendmoney';
  // Called after a successful REAL Estimate import (not the mock path) so
  // the caller can refetch its own table data — mirrors UploadExcelModal's
  // own onImported contract.
  onImported?: () => void;
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
  remarksSuggestions = [],
  typeOptions = [],
  moduleKind = 'settlement',
  allowEstimateMode = false,
  estimateApiBasePath,
  estimateExtractShopName,
  estimateSkipShopNames = [],
  importApiBasePath,
  product,
  onImported,
}: BulkImportModalProps) {
  const [step, setStep] = useState<Step>('upload');
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanMessageIndex, setScanMessageIndex] = useState(0);
  const [rows, setRows] = useState<ImportRow[]>([]);
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
  // Phase 10 — Settlement/Top Up only. Every distinct upload date that
  // isn't today's business date must be explicitly acknowledged before
  // Import Data enables, per explicit "Need Validation" spec — a soft
  // confirmation gate, not a data-correctness check (checkDateField already
  // hard-rejects unparseable/future dates on its own; this is purely "are
  // you sure this date is right," so the server has nothing new to verify).
  // Keyed by the row date's own raw string (e.g. "8/13/2026") so it lines
  // up directly with what's displayed and what group of rows it covers.
  const [confirmedDates, setConfirmedDates] = useState<Set<string>>(new Set());
  // Duplicates panel — one explicit decision per row (never defaults to
  // either choice). 'skip' mirrors into skippedRows (the same set the
  // Errors table's Skip already writes into, and what actually gets sent
  // to the server as excludedRows) — 'import' removes it from skippedRows.
  const [duplicateDecisions, setDuplicateDecisions] = useState<Record<number, 'skip' | 'import'>>({});
  // Every panel in the Ready to Import step now starts collapsed, Errors
  // included — matches the reference mockup's own default state; the user
  // expands whichever panel(s) they actually want to act on via its
  // chevron, rather than everything dumping open at once.
  const [duplicatesPanelOpen, setDuplicatesPanelOpen] = useState(false);
  // "Already imported" cross-check — fetched once per scan (see the
  // scanning effect below), held stable through post-edit re-validation.
  // alreadyImportedMatchByRow is display-only (the row's subtext) —
  // gating/KPI counts all come from the same `entries`/`type: 'duplicate'`
  // mechanism the in-file check already uses, nothing new there.
  const [existingRecords, setExistingRecords] = useState<ExistingTransactionSignature[]>([]);
  const [alreadyImportedMatchByRow, setAlreadyImportedMatchByRow] = useState<Map<number, ExistingTransactionSignature>>(new Map());
  // Opening's daily-upload New Shops confirmation — fetched once per scan
  // (same "part of the existing scan, no new loading state" convention as
  // existingRecords above), the current roster this file's Agent Names get
  // matched against. newShopDecisions mirrors importOpeningFile's own
  // NewShopDecision shape exactly (see importService.ts) — sent as-is at
  // import time.
  const [existingRoster, setExistingRoster] = useState<OpeningRosterEntry[]>([]);
  const [newShopDecisions, setNewShopDecisions] = useState<Record<number, NewShopDecision>>({});
  const [newShopsPanelOpen, setNewShopsPanelOpen] = useState(false);
  // SDP-change confirmation (Phase 2) — one decision per flagged row.
  // 'skip' excludes just that row's SDP update at import time (the rest of
  // the row, e.g. Opening Balance, still applies normally) — unlike
  // skippedRows/duplicateDecisions, this never removes the row from the
  // import entirely.
  const [sdpChangeDecisions, setSdpChangeDecisions] = useState<Record<number, 'confirm' | 'skip'>>({});
  const [sdpChangesPanelOpen, setSdpChangesPanelOpen] = useState(false);
  // Missing Shops review — moved into the Ready to Import step (Roster
  // Changes group), a real blocking decision same as every other panel
  // here. Keyed by agentCode.lower, not row number — a missing shop has no
  // row in the uploaded file at all. 'keep' is a client-side-only decision
  // (no network call, but still resolves the row for gating purposes);
  // 'inactive' PATCHes the existing /api/v2/opening (or sendmoney) route.
  // Zero Out removed per explicit request — Keep and Mark Inactive are the
  // only two actions now.
  const [missingShopDecisions, setMissingShopDecisions] = useState<Record<string, 'keep' | 'inactive'>>({});
  const [missingShopBusy, setMissingShopBusy] = useState<Record<string, boolean>>({});
  const [missingShopErrors, setMissingShopErrors] = useState<Record<string, string>>({});
  const [missingShopsPanelOpen, setMissingShopsPanelOpen] = useState(false);
  const [importDone, setImportDone] = useState(0);
  const [importCompletedAt, setImportCompletedAt] = useState<Date | null>(null);
  // Opening module only (Phase 4) — real network write, mirrors
  // estimateImportError's own pattern exactly. Settlement/Top Up still use
  // the mock path below (mockImportRecords), untouched, out of this
  // phase's scope.
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelImportRef = useRef<() => void>(() => {});
  // Presentational-only progress simulation for the real Settlement/Top
  // Up/Opening import POST — see handleGenericImportStart/
  // handleOpeningImportStart. There's no per-row signal from that single
  // request, so this ticks importDone up while the fetch is in flight and
  // is always cleared before importDone gets trusted for anything real.
  const importProgressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Lags `isOpen` by the exit-animation duration, same pattern as
  // RecordFormModal — the closing fade/scale actually gets to play instead
  // of the component unmounting mid-transition.
  const [rendered, setRendered] = useState(isOpen);
  const [closing, setClosing] = useState(false);

  // Estimate Mode (Opening Balance only) — a completely separate client-side
  // pipeline from the mock rows/entries/summary state above: raw wallet-level
  // rows (Account/Bank/Total DP/Total WD), no roster/agentName validation, a
  // REAL network write instead of mockImportRecords. Kept in its own state
  // block rather than folded into the generic rows/summary shape above since
  // its data doesn't fit that per-agent-record model at all.
  const [estimateMode, setEstimateMode] = useState(false);
  const [estimateParsed, setEstimateParsed] = useState<{ headerRow: (string | number)[]; dataRows: (string | number)[][] } | null>(null);
  const [estimateDetectedShops, setEstimateDetectedShops] = useState(0);
  const [estimateDetectedErrors, setEstimateDetectedErrors] = useState(0);
  const [estimateRowErrors, setEstimateRowErrors] = useState<EstimateRowError[]>([]);
  const [estimateErrorsExpanded, setEstimateErrorsExpanded] = useState(false);
  const [estimateImportProgress, setEstimateImportProgress] = useState(0);
  const [estimateImportError, setEstimateImportError] = useState<string | null>(null);
  const [estimateImportResult, setEstimateImportResult] = useState<EstimateImportRecord | null>(null);
  const [lastImport, setLastImport] = useState<EstimateImportRecord | null>(null);
  const estimateProgressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetched as soon as the modal opens (not gated behind ticking the
  // checkbox) so Last Import is ready the instant Estimate Mode is checked —
  // same as the old standalone UploadExcelModal's own effect.
  useEffect(() => {
    if (!isOpen || !allowEstimateMode || !estimateApiBasePath) return;
    fetch(`${estimateApiBasePath}/estimated-balance?t=${Date.now()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { lastImport: EstimateImportRecord | null } | null) => {
        if (data?.lastImport) setLastImport(data.lastImport);
      })
      .catch(() => {
        // Couldn't reach the server — just skip showing Last Import rather
        // than blocking the modal from opening.
      });
  }, [isOpen, allowEstimateMode, estimateApiBasePath]);

  const validationConfig: ValidationConfig & TopUpValidationConfig & OpeningValidationConfig = useMemo(() => ({
    brandOptions,
    walletOptions,
    agentRoster,
    remarksSuggestions,
    typeOptions,
  }), [brandOptions, walletOptions, agentRoster, remarksSuggestions, typeOptions]);

  // Shared by the initial scan AND every post-edit re-check — a single
  // source of truth for "given these rows, what issues do they have," so
  // an edit that resolves a duplicate genuinely clears it (see
  // handleRowEditSave below) instead of the panel showing stale state.
  // Branches on moduleKind since Settlement/Top Up/Opening each have their
  // own typed validator (Remarks is a soft warning, Type a hard error,
  // Opening Balance/SDP allow blank) — the within-file duplicate check
  // below is already generic over every row shape (see duplicateDetector.ts);
  // Opening uses its own agentName-only dedup key instead of Settlement/Top
  // Up's brand+wallet+amount+date signature, since a roster snapshot has
  // none of those.
  //
  // Round 3 — mockExistingRecordCheck() (a positional "every 7th row" stand-
  // in for a real cross-upload "does this already exist in the DB" check,
  // explicitly documented from the start as a prototype-phase placeholder,
  // "do NOT implement backend yet") used to run here too. Removed: since it
  // flagged rows purely by ARRAY INDEX, never by field values, editing a
  // row's data could never clear it if that row's position happened to be a
  // multiple of 7 — a row genuinely made unique would still show as
  // "Duplicate" forever. The real "already exists" check now only ever
  // happens server-side (the SHA-256 fingerprint check in importService.ts,
  // at actual import time) — there's no live client-side equivalent to
  // preview pre-upload without a per-row DB round trip, so this file only
  // ever reports genuine within-file matches — UNTIL now (see
  // existingRecords below): detectAlreadyImportedDuplicates is the REAL
  // replacement, a genuine live check against wallet_transactions.
  //
  // existingRecords is passed in explicitly (not captured via closure) so
  // the scanning step can hand it the just-fetched, definitely-current
  // value without a state-update race — see the scanning effect below,
  // which awaits the fetch and calls this with the local result directly,
  // before existingRecords state has necessarily re-rendered yet.
  // handleRowEditSave (post-edit re-validation) passes the already-settled
  // existingRecords state — no new fetch per edit, an edited row's date
  // is still checked correctly since the SIGNATURE comparison (not the
  // fetch) is what re-runs.
  const runValidation = useCallback((inputRows: ImportRow[], existingRecords: ExistingTransactionSignature[]): { entries: ValidationEntry[]; alreadyImportedMatchByRow: Map<number, ExistingTransactionSignature> } => {
    if (moduleKind === 'opening') {
      return {
        entries: [
          ...validateOpeningRows(inputRows as OpeningImportRow[]),
          ...detectDuplicateAgentNames(inputRows),
        ],
        alreadyImportedMatchByRow: new Map(),
      };
    }
    const sixthField = (row: SettlementImportRow | TopUpImportRow): string =>
      (moduleKind === 'topup' ? (row as TopUpImportRow).type : (row as SettlementImportRow).remarks) ?? '';
    const rows = inputRows as (SettlementImportRow | TopUpImportRow)[];
    const alreadyImported = detectAlreadyImportedDuplicates(rows, existingRecords, sixthField, (row) => toDateKey(row.date));
    return {
      entries: [
        ...(moduleKind === 'topup'
          ? validateTopUpRows(inputRows as TopUpImportRow[], validationConfig)
          : validateSettlementRows(inputRows as SettlementImportRow[], validationConfig)),
        ...detectDuplicatesWithinFile(inputRows as SettlementImportRow[]),
        ...alreadyImported.entries,
      ],
      alreadyImportedMatchByRow: alreadyImported.matchByRow,
    };
  }, [validationConfig, moduleKind]);

  // What counts as "the row's headline amount" for the Total Amount stat
  // card / Complete screen — Opening Balance for the 'opening' module,
  // Amount for everyone else.
  const getRowAmount = useCallback((row: ImportRow): string => (
    moduleKind === 'opening' ? (row.openingBalance ?? '') : (row.amount ?? '')
  ), [moduleKind]);

  const calculateSummary = useCallback((inputRows: ImportRow[], inputEntries: ValidationEntry[]): ImportSummary => (
    moduleKind === 'opening'
      ? calculateOpeningImportSummary(inputRows as OpeningImportRow[], inputEntries)
      : calculateImportSummary(inputRows as SettlementImportRow[], inputEntries)
  ), [moduleKind]);

  // Same field set as each module's own New/Edit Record modal, fed by this
  // modal's own props so a fix made here is held to the exact same rules as
  // the rest of the app. Settlement's Remarks is free text with suggestions
  // (allowCustom); Top Up's Type is a closed single-value set (no
  // allowCustom — matching the fixed literal every real Top Up row has).
  // Opening Balance has a genuinely different, shorter field set — no
  // Brand/Wallet/Date, matching the real official templates exactly (Leader
  // is free text, Opening Balance/SDP are both optional on both products).
  const importRecordFields: RecordFormField[] = useMemo(() => {
    if (moduleKind === 'opening') {
      return [
        { key: 'agentName', label: 'Agent Name', kind: 'combobox', options: agentRoster, required: true },
        { key: 'leader', label: 'Leader', kind: 'text' },
        { key: 'openingBalance', label: 'Opening Balance', kind: 'amount' },
        { key: 'sdp', label: 'SDP', kind: 'amount' },
      ];
    }
    const base: RecordFormField[] = [
      { key: 'brand', label: 'Brand', kind: 'combobox', options: brandOptions, required: true },
      { key: 'agentName', label: 'Agent Name', kind: 'combobox', options: agentRoster, required: true },
      { key: 'wallet', label: 'Wallet', kind: 'combobox', options: walletOptions, required: true },
      { key: 'amount', label: 'Amount', kind: 'amount', required: true },
    ];
    const sixthField: RecordFormField = moduleKind === 'topup'
      ? { key: 'type', label: 'Type', kind: 'combobox', options: typeOptions, required: true }
      : { key: 'remarks', label: 'Remarks', kind: 'combobox', options: remarksSuggestions, allowCustom: true };
    return [...base, sixthField, { key: 'date', label: 'Date', kind: 'date', required: true }];
  }, [brandOptions, agentRoster, walletOptions, remarksSuggestions, typeOptions, moduleKind]);

  // Live, per-field business-rule check — the exact same functions the bulk
  // scan uses, reused here so the Edit Row dialog shows the REAL reason a
  // field is invalid (and its "Available X" list) instead of a generic
  // message, and re-evaluates on every keystroke so a fix clears the
  // warning immediately.
  const getFieldHint = useCallback((key: string, value: string) => {
    switch (key) {
      case 'brand': return checkBrandField(value, validationConfig);
      case 'agentName': return moduleKind === 'opening'
        ? (checkAgentNameRequired(value) ?? checkAgentNameFormat(value))
        : checkAgentNameField(value, validationConfig);
      case 'wallet': return checkWalletField(value, validationConfig);
      case 'amount': return checkAmountField(value);
      case 'date': return checkDateField(value);
      case 'type': return checkTypeField(value, validationConfig);
      case 'openingBalance': return checkOptionalAmountField(value);
      case 'sdp': return checkOptionalAmountField(value);
      default: return null;
    }
  }, [validationConfig, moduleKind]);

  const toggleSkip = useCallback((rowNumber: number) => {
    setSkippedRows((current) => {
      const next = new Set(current);
      if (next.has(rowNumber)) next.delete(rowNumber); else next.add(rowNumber);
      return next;
    });
  }, []);

  // Errors panel's "Skip All" — marks every row passed in as skipped in one
  // shot. Called with the FULL unresolved-error row list (not just the
  // rendered subset), so it still clears the whole backlog on a file whose
  // error count exceeds the panel's 20-row display cap and rows beyond it
  // were never mounted to Skip individually.
  const skipRows = useCallback((rowNumbers: number[]) => {
    setSkippedRows((current) => {
      const next = new Set(current);
      rowNumbers.forEach((rowNumber) => next.add(rowNumber));
      return next;
    });
  }, []);

  // Duplicates panel — a decision is a first-class choice per row, not a
  // toggle: 'skip' both records the decision AND excludes the row (mirrored
  // into skippedRows, the same set the Errors table's Skip already writes
  // into and what handleGenericImportStart/handleOpeningImportStart already
  // send to the server as excludedRows); 'import' does the opposite.
  const setDuplicateDecision = useCallback((rowNumber: number, decision: 'skip' | 'import') => {
    setDuplicateDecisions((current) => ({ ...current, [rowNumber]: decision }));
    setSkippedRows((current) => {
      const next = new Set(current);
      if (decision === 'skip') next.add(rowNumber); else next.delete(rowNumber);
      return next;
    });
  }, []);

  const applyDuplicateDecisionToAll = useCallback((decision: 'skip' | 'import', rowNumbers: number[]) => {
    setDuplicateDecisions((current) => {
      const next = { ...current };
      rowNumbers.forEach((rowNumber) => { next[rowNumber] = decision; });
      return next;
    });
    setSkippedRows((current) => {
      const next = new Set(current);
      rowNumbers.forEach((rowNumber) => { if (decision === 'skip') next.add(rowNumber); else next.delete(rowNumber); });
      return next;
    });
  }, []);

  const editingRow = useMemo(() => rows.find((row) => row.row === editingRowNumber) ?? null, [rows, editingRowNumber]);

  const editingInitialValues: Record<string, string> = useMemo((): Record<string, string> => {
    if (moduleKind === 'opening') {
      if (!editingRow) return { agentName: '', leader: '', openingBalance: '', sdp: '' };
      return {
        agentName: toProperCase(editingRow.agentName),
        leader: editingRow.leader ?? '',
        openingBalance: editingRow.openingBalance ? String(parseAmount(editingRow.openingBalance)) : '',
        sdp: editingRow.sdp ? String(parseAmount(editingRow.sdp)) : '',
      };
    }
    const sixthKey = moduleKind === 'topup' ? 'type' : 'remarks';
    if (!editingRow) return { brand: '', agentName: '', wallet: '', amount: '', [sixthKey]: '', date: '' };
    return {
      brand: (editingRow.brand ?? '').toUpperCase(),
      agentName: toProperCase(editingRow.agentName),
      wallet: toProperCase(editingRow.wallet ?? ''),
      amount: editingRow.amount ? String(parseAmount(editingRow.amount)) : '',
      [sixthKey]: moduleKind === 'topup' ? (editingRow.type ?? '') : (editingRow.remarks ?? ''),
      date: formatDateForEdit(editingRow.date ?? ''),
    };
  }, [editingRow, moduleKind]);

  // RowIssueEditModal's own dynamic microcopy + per-field highlighting —
  // driven by the same `entries` the review table/duplicates panel already
  // read, scoped to whichever row is currently open.
  const editingRowIssues = useMemo(
    () => (editingRowNumber === null ? [] : entries.filter((entry) => entry.row === editingRowNumber)),
    [entries, editingRowNumber]
  );
  const editingRowHasError = editingRowIssues.some((issue) => issue.type === 'error');
  const editingRowHasDuplicate = editingRowIssues.some((issue) => issue.type === 'duplicate');

  const editingNoticeText = editingRowHasDuplicate
    ? editingRowHasError
      ? 'This row has a validation error and also exactly matches another row (every field matches). Fix the highlighted error below, or change any field to resolve the duplicate.'
      : 'This row exactly matches another row (Brand, Agent, Amount, Wallet, Type, and Date all match). Change any field to resolve.'
    : editingRowIssues.length > 0
      ? `This row has ${editingRowIssues.length} validation issue${editingRowIssues.length !== 1 ? 's' : ''} — see the highlighted field${editingRowIssues.length !== 1 ? 's' : ''} below.`
      : '';
  const editingNoticeVariant: 'error' | 'duplicate' = editingRowHasError ? 'error' : 'duplicate';

  const editingHighlightedKeys: Set<string> | 'all' = editingRowHasDuplicate
    ? 'all'
    : new Set(
        editingRowIssues
          .map((issue) => ISSUE_FIELD_TO_KEY[issue.field])
          .filter((key): key is string => Boolean(key))
      );

  const handleRowEditSave = useCallback((values: Record<string, string>) => {
    setRows((currentRows) => {
      const updatedRows = currentRows.map((row) => {
        if (row.row !== editingRowNumber) return row;
        if (moduleKind === 'opening') {
          return {
            ...row,
            agentName: values.agentName ?? '',
            leader: values.leader ?? '',
            openingBalance: values.openingBalance ?? '',
            sdp: values.sdp ?? '',
          };
        }
        return {
          ...row,
          brand: values.brand ?? '',
          agentName: values.agentName ?? '',
          wallet: values.wallet ?? '',
          amount: values.amount ?? '',
          date: values.date ?? '',
          ...(moduleKind === 'topup' ? { type: values.type ?? '' } : { remarks: values.remarks ?? '' }),
        };
      });
      const { entries: newEntries, alreadyImportedMatchByRow: newMatches } = runValidation(updatedRows, existingRecords);
      setEntries(newEntries);
      setAlreadyImportedMatchByRow(newMatches);
      setSummary(calculateSummary(updatedRows, newEntries));
      return updatedRows;
    });
    // The data just changed, so a previously-recorded "Import anyway" on
    // this row is stale — it needs a fresh look, not a decision made
    // against the old values. A previously-recorded "Skip" stays as-is,
    // same as the Errors table's own Skip already not being undone by
    // editing.
    if (editingRowNumber !== null) {
      setDuplicateDecisions((current) => {
        if (current[editingRowNumber] !== 'import') return current;
        const next = { ...current };
        delete next[editingRowNumber];
        return next;
      });
    }
  }, [editingRowNumber, runValidation, calculateSummary, moduleKind, existingRecords]);

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
    setExistingRecords([]);
    setAlreadyImportedMatchByRow(new Map());
    setExistingRoster([]);
    setNewShopDecisions({});
    setSdpChangeDecisions({});
    setMissingShopDecisions({});
    setMissingShopBusy({});
    setMissingShopErrors({});
    setSummary(null);
    setIssuesExpanded(false);
    setEditingRowNumber(null);
    setSkippedRows(new Set());
    setConfirmedDates(new Set());
    setDuplicateDecisions({});
    setDuplicatesPanelOpen(false);
    setNewShopsPanelOpen(false);
    setSdpChangesPanelOpen(false);
    setMissingShopsPanelOpen(false);
    setImportDone(0);
    setImportCompletedAt(null);
    cancelImportRef.current();
    if (importProgressTimerRef.current) {
      clearInterval(importProgressTimerRef.current);
      importProgressTimerRef.current = null;
    }
    setEstimateMode(false);
    setEstimateParsed(null);
    setEstimateDetectedShops(0);
    setEstimateDetectedErrors(0);
    setEstimateRowErrors([]);
    setEstimateErrorsExpanded(false);
    setEstimateImportProgress(0);
    setEstimateImportError(null);
    setEstimateImportResult(null);
    if (estimateProgressTimerRef.current) {
      clearInterval(estimateProgressTimerRef.current);
      estimateProgressTimerRef.current = null;
    }
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
      // Estimate Mode's raw wallet-level file has nothing to do with the
      // agent-roster row shape below — parsed and validated entirely
      // separately (see parseEstimateRows), landing straight on 'validation'
      // with its own state instead of rows/entries/summary.
      if (estimateMode) {
        let failure: string | null = null;
        let parsedHeaderRow: (string | number)[] = [];
        let parsedDataRows: (string | number)[][] = [];
        let result: { detectedShops: number; detectedErrors: number; rowErrors: EstimateRowError[] } | null = null;
        try {
          const buffer = await file.arrayBuffer();
          const workbook = XLSX.read(buffer, { type: 'array' });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const sheetRows: (string | number)[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
          const [headerRow, ...dataRows] = sheetRows;
          if (!headerRow || headerRow.length === 0) throw new Error('The file appears to be empty.');
          parsedHeaderRow = headerRow;
          parsedDataRows = dataRows;
          result = parseEstimateRows(headerRow, dataRows, estimateExtractShopName!, estimateSkipShopNames);
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

        if (failure || !result) {
          setScanError(failure ?? 'Could not read this file.');
          setStep('upload');
          return;
        }
        setEstimateParsed({ headerRow: parsedHeaderRow, dataRows: parsedDataRows });
        setEstimateDetectedShops(result.detectedShops);
        setEstimateDetectedErrors(result.detectedErrors);
        setEstimateRowErrors(result.rowErrors);
        setStep('validation');
        return;
      }

      let parsedRows: ImportRow[] = [];
      let computedEntries: ValidationEntry[] = [];
      let computedMatches: Map<number, ExistingTransactionSignature> = new Map();
      let fetchedExistingRecords: ExistingTransactionSignature[] = [];
      let fetchedExistingRoster: OpeningRosterEntry[] = [];
      let failure: string | null = null;
      try {
        const parsed = await parseWorkbookFile(file);
        parsedRows = moduleKind === 'opening' ? mapOpeningRows(parsed, product) : moduleKind === 'topup' ? mapTopUpRows(parsed) : mapSettlementRows(parsed);

        // "Already imported" cross-check — part of this same scan, not a
        // separate step (no extra loading state). Settlement/Top Up only;
        // dates come from the file's OWN rows (a file can span several
        // dates), never a fixed "today" — a row is only ever compared
        // against existing records sharing its own date.
        if (moduleKind !== 'opening' && product) {
          const distinctDates = Array.from(new Set(
            (parsedRows as (SettlementImportRow | TopUpImportRow)[])
              .map((row) => toDateKey(row.date))
              .filter((key): key is string => key !== null)
          ));
          if (distinctDates.length > 0) {
            const existingRes = await fetch('/api/v2/import/existing-records', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ product, transactionType: moduleKind, dates: distinctDates }),
            });
            // A failed check here doesn't fail the whole scan — the in-file
            // check and the server's own fingerprint check at actual import
            // time still apply; this is an added safety net, not the only one.
            if (existingRes.ok) fetchedExistingRecords = await existingRes.json();
          }
        }

        // New Shops confirmation + SDP-change confirmation — same "part of
        // the existing scan" pattern. Reuses the existing GET /api/v2/opening
        // (or /sendmoney/opening) roster endpoint that already powers Today's
        // Opening's own page — no new route. A failed fetch here isn't
        // treated as a hard scan failure either: it just means every row
        // falls back to looking "new" and no SDP-change check runs (the
        // panels/gates still work correctly, just conservatively), matching
        // the existing-records check's own "added safety net, not the only
        // path" stance above. Cashout's read side already coerces sdp to a
        // real number (0 for null); Send Money's own securityDeposit stays
        // nullable — normalized to the same `sdp: number | null` field here
        // either way, since a genuinely-null previous value is exactly what
        // skips the SDP-change check ("nothing to compare against").
        //
        // Bug fix — this used to gate on the `product` PROP, which neither
        // app/summary/page.tsx nor app/sendmoney/opening/page.tsx actually
        // passes to this modal for their Opening instance (both only wire
        // estimateApiBasePath). The roster fetch above silently never ran
        // at all, so existingRoster stayed permanently empty and every row
        // that happened to reach the New Shop check (i.e. any row that also
        // had an unrelated issue, like an in-file duplicate) got wrongly
        // flagged as new — confirmed against a genuinely existing shop
        // (AGATE002BK) that should never have shown that badge. Derived the
        // same way handleOpeningImportStart already derives its own local
        // `product` below, since that's Opening's real, established
        // product-detection convention — not the `product` prop.
        const openingProduct = estimateApiBasePath?.includes('sendmoney') ? 'sendmoney' : 'cashout';
        if (moduleKind === 'opening') {
          const rosterRes = await fetch(openingProduct === 'sendmoney' ? '/api/v2/sendmoney/opening' : '/api/v2/opening');
          if (rosterRes.ok) {
            const rosterJson = await rosterRes.json();
            fetchedExistingRoster = (rosterJson as { agentCode: string; leader: string | null; sdp?: number | null; securityDeposit?: number | null; lastImportMatchedAt: string | null }[])
              .map((r) => ({
                agentCode: r.agentCode,
                leader: r.leader ?? '',
                sdp: openingProduct === 'sendmoney' ? (r.securityDeposit ?? null) : (r.sdp ?? null),
                lastImportMatchedAt: r.lastImportMatchedAt ?? null,
              }));
          }
        }

        const validated = runValidation(parsedRows, fetchedExistingRecords);
        computedEntries = validated.entries;
        computedMatches = validated.alreadyImportedMatchByRow;
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
      setExistingRecords(fetchedExistingRecords);
      setAlreadyImportedMatchByRow(computedMatches);
      setExistingRoster(fetchedExistingRoster);
      setSummary(calculateSummary(parsedRows, computedEntries));
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

  // Blocking errors AND duplicate flags share one underlying row index —
  // both need Edit/Skip actions, just surfaced through two different
  // panels below (Errors table vs Duplicates panel). Warnings stay
  // excluded (soft, never gate anything, no row-level action needed).
  const reviewEntries = useMemo(
    () => entries.filter((entry) => entry.type === 'error' || entry.type === 'duplicate').sort((a, b) => a.row - b.row),
    [entries]
  );

  // One row per RECORD (not per issue) — "Row 8 / Wallet, Type" (the actual
  // field names, not a bare count) instead of two separate table rows. A
  // row stays visible here even after its issues are fixed as long as it's
  // still Skipped, so Restore
  // remains reachable.
  const reviewRowGroups = useMemo(() => {
    const issuesByRow = new Map<number, ValidationEntry[]>();
    reviewEntries.forEach((entry) => {
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
        // Opening rows have no wallet/amount at all — '−'/'' match this
        // app's established zero/empty display convention.
        wallet: sourceRow?.wallet || '−',
        amount: sourceRow?.amount ?? '',
        issues,
        hasError: issues.some((issue) => issue.type === 'error'),
        skipped: skippedRows.has(rowNumber),
      };
    });
  }, [reviewEntries, rows, skippedRows]);

  // The Errors table only ever shows rows with a real blocking error —
  // duplicate-only rows moved out to their own panel below.
  const errorRowGroups = useMemo(() => reviewRowGroups.filter((group) => group.hasError), [reviewRowGroups]);

  // Duplicate-only rows (flagged 'duplicate', never also 'error') — these
  // get the dedicated panel instead of the Errors table.
  const duplicateOnlyRowGroups = useMemo(
    () => reviewRowGroups.filter((group) => !group.hasError && group.issues.some((issue) => issue.type === 'duplicate')),
    [reviewRowGroups]
  );

  // Settlement/Top Up's own "6th field" convention (Type for Top Up,
  // Remarks-labeled-as-Type on the Settlement template) — same key already
  // used by importRecordFields/editingInitialValues below, reused here so
  // the cluster signature and the Edit form agree on what "Type" means.
  const sixthFieldKey = moduleKind === 'topup' ? 'type' : 'remarks';

  // Groups already-flagged duplicate rows into exact-match clusters for
  // display. Settlement/Top Up: Brand+Agent+Amount+Wallet+Type+Date, all six
  // fields, per the approved duplicate match criteria. This is a
  // DISPLAY-only grouping layered on top of duplicateDetector.ts's own
  // (unchanged) 5-field flagging: a row already flagged 'duplicate' whose
  // Type happens to differ from every other row sharing its other 5 fields
  // ends up alone in its own cluster (rendered as a single card, no
  // "Matches Row N" line) rather than being dropped — every flagged row
  // stays visible somewhere.
  // Opening: agent name is the ENTIRE signature, matching
  // detectDuplicateAgentNames' own criterion exactly (Opening rows have no
  // brand/wallet/amount/date to fold in) — this used to bail out to an
  // empty array here, silently leaving Opening's duplicate rows with no
  // panel content at all despite the header/KPI/gating already counting
  // them (bug: "1 possible duplicate found" with nothing rendered under it).
  type DuplicateClusterRow = { row: number; agent: string; leader: string; brand: string; wallet: string; amount: string; type: string; date: string; skipped: boolean };
  const duplicateClusters = useMemo(() => {
    const bySignature = new Map<string, DuplicateClusterRow[]>();
    duplicateOnlyRowGroups.forEach((group) => {
      const sourceRow = rows.find((row) => row.row === group.row);
      if (!sourceRow) return;
      const sixthValue = moduleKind === 'opening' ? '' : (sourceRow[sixthFieldKey] ?? '');
      const signature = moduleKind === 'opening'
        ? sourceRow.agentName.trim().toLowerCase()
        : [
            sourceRow.brand, sourceRow.agentName, sourceRow.wallet,
            sourceRow.amount ? parseAmount(sourceRow.amount) : '',
            sixthValue, sourceRow.date,
          ].map((part) => String(part ?? '').trim().toLowerCase()).join('|');
      const entry: DuplicateClusterRow = {
        row: group.row,
        agent: sourceRow.agentName,
        leader: sourceRow.leader ?? '',
        brand: (sourceRow.brand ?? '').toUpperCase(),
        wallet: sourceRow.wallet ?? '',
        amount: sourceRow.amount ?? '',
        type: String(sixthValue),
        date: sourceRow.date ?? '',
        skipped: group.skipped,
      };
      if (!bySignature.has(signature)) bySignature.set(signature, []);
      bySignature.get(signature)!.push(entry);
    });
    return Array.from(bySignature.values())
      .map((clusterRows) => ({
        signature: clusterRows.map((r) => r.row).join('-'),
        rows: clusterRows.sort((a, b) => a.row - b.row),
      }))
      .sort((a, b) => a.rows[0].row - b.rows[0].row);
  }, [duplicateOnlyRowGroups, rows, moduleKind, sixthFieldKey]);

  // Still blocking = has at least one real ERROR AND hasn't been skipped.
  // Duplicates have their own separate gate below (allDuplicatesDecided/
  // duplicatesConfirmed) — they no longer bypass Continue by default.
  const activeErrorCount = useMemo(
    () => errorRowGroups.filter((group) => !group.skipped).length,
    [errorRowGroups]
  );
  // Every row with a real blocking error, regardless of skip state — used
  // below by New Shops/SDP Changes, which (unlike errorRowGroups/
  // duplicateOnlyRowGroups) need to scan EVERY uploaded row, not just rows
  // that already happen to be in reviewRowGroups (that set only ever
  // contains rows with an existing error/duplicate entry or an explicit
  // Skip — a plain row with no other issue is invisible there, which used
  // to make a genuinely new shop with clean data invisible to the New Shops
  // check entirely, and only catch a new/missing-roster shop when it also
  // happened to have some unrelated flag, like an in-file duplicate).
  const errorRowNumbers = useMemo(() => new Set(errorRowGroups.map((group) => group.row)), [errorRowGroups]);

  // Every duplicate row (across every cluster) needs an explicit decision
  // before Continue can enable — Skip and Import anyway are equally valid,
  // there's just no silent default.
  const allDuplicatesDecided = useMemo(
    () => duplicateClusters.every((cluster) => cluster.rows.every((row) => duplicateDecisions[row.row] !== undefined)),
    [duplicateClusters, duplicateDecisions]
  );
  const duplicatesConfirmed = duplicateClusters.length === 0 || allDuplicatesDecided;

  // New Shops — Opening only. existingRosterByCode is the current roster
  // fetched at scan time (see the scanning effect); a row whose Agent Name
  // isn't in it has nothing to match against, so it needs an explicit
  // insert/link decision before it can go anywhere near the database.
  const existingRosterByCode = useMemo(
    () => new Map(existingRoster.map((r) => [r.agentCode.trim().toLowerCase(), r])),
    [existingRoster]
  );
  const leaderOptions = useMemo(
    () => Array.from(new Set(existingRoster.map((r) => r.leader).filter((name) => name.trim() !== ''))).sort((a, b) => a.localeCompare(b)),
    [existingRoster]
  );
  const existingRosterAgentCodes = useMemo(() => existingRoster.map((r) => r.agentCode), [existingRoster]);
  // A 'link' decision resolves the row the moment a real agentCode is
  // picked — at that point it's no longer "new," it's folded into the
  // normal matched/update path, so it drops out of this list entirely
  // (matches how duplicateOnlyRowGroups stops tracking a duplicate once
  // decided). An 'insert' decision stays visible either way, since the row
  // genuinely IS going to be inserted — it just also needs to show whether
  // its Leader is filled in yet.
  const newShopRowGroups = useMemo(() => {
    if (moduleKind !== 'opening') return [];
    return rows
      .filter((row) => !skippedRows.has(row.row) && !errorRowNumbers.has(row.row))
      .filter((row) => !existingRosterByCode.has((row.agentName ?? '').trim().toLowerCase()))
      .filter((row) => {
        const decision = newShopDecisions[row.row];
        return !(decision?.action === 'link' && decision.agentCode.trim() !== '');
      })
      .map((row) => ({ row: row.row, agent: row.agentName }));
  }, [moduleKind, rows, skippedRows, errorRowNumbers, existingRosterByCode, newShopDecisions]);

  // Bulk "Yes, new shop" — unlike Duplicates' Skip all/Import all anyway
  // (a real binary choice, always fully resolvable in bulk), a row with no
  // Leader in the file genuinely CAN'T be confirmed this way — Leader is
  // required, so that row is deliberately left exactly as it was (no
  // decision written, still visibly unresolved in the panel) rather than
  // silently skipped or defaulted. Only "Yes, new shop" gets a bulk
  // version — "No — matches existing" needs a specific shop picked per
  // row, there's no sensible bulk form of that.
  const confirmAllNewShopsAsNew = useCallback(() => {
    setNewShopDecisions((current) => {
      const next = { ...current };
      newShopRowGroups.forEach((group) => {
        const leader = (rows.find((r) => r.row === group.row)?.leader ?? '').trim();
        if (!leader) return;
        next[group.row] = { action: 'insert', leader };
      });
      return next;
    });
  }, [newShopRowGroups, rows]);

  const newShopsConfirmed = useMemo(
    () => newShopRowGroups.every((group) => {
      const decision = newShopDecisions[group.row];
      return decision?.action === 'insert' && decision.leader.trim() !== '';
    }),
    [newShopRowGroups, newShopDecisions]
  );

  // SDP Changes — Opening only. A row resolves to a "previous SDP" either
  // via its own Agent Name already matching the roster, or via a resolved
  // 'link' decision (a New Shop row the user pointed at an existing shop) —
  // either way it's now a normal matched row, so its SDP gets the same
  // scrutiny. Genuinely new shops (confirmed inserts) have nothing to
  // compare against and are never eligible — same "no previous value" logic
  // as importOpeningFile's own insert path. prev === null/0 also skips the
  // check entirely (division-by-zero guard, and "no previous value to
  // compare against" is the same case either way per spec).
  type SdpChangeRow = { row: number; agent: string; prevSdp: number; newSdp: number; pctChange: number };
  const sdpChangeRowGroups = useMemo((): SdpChangeRow[] => {
    if (moduleKind !== 'opening') return [];
    return rows.flatMap((row): SdpChangeRow[] => {
      if (skippedRows.has(row.row) || errorRowNumbers.has(row.row)) return [];
      const agentName = row.agentName ?? '';
      const decision = newShopDecisions[row.row];
      const targetCode = decision?.action === 'link' && decision.agentCode.trim() !== ''
        ? decision.agentCode
        : existingRosterByCode.has(agentName.trim().toLowerCase())
        ? agentName
        : null;
      if (!targetCode) return [];
      const roster = existingRosterByCode.get(targetCode.trim().toLowerCase());
      if (!roster || !roster.sdp) return [];
      const newSdp = parseAmount(row.sdp ?? '');
      const pctChange = Math.abs(newSdp - roster.sdp) / roster.sdp;
      if (pctChange < SDP_CHANGE_THRESHOLD) return [];
      return [{ row: row.row, agent: agentName, prevSdp: roster.sdp, newSdp, pctChange }];
    });
  }, [moduleKind, rows, skippedRows, errorRowNumbers, newShopDecisions, existingRosterByCode]);
  const sdpChangesConfirmed = useMemo(
    () => sdpChangeRowGroups.every((row) => sdpChangeDecisions[row.row] !== undefined),
    [sdpChangeRowGroups, sdpChangeDecisions]
  );

  // Missing Shops — the roster snapshot fetched at scan time, minus every
  // agentCode appearing ANYWHERE in the uploaded file (regardless of that
  // row's own skip/error/decision state — a row that errored out still
  // means this shop WAS present in today's file, just not successfully
  // processed; that's a different problem, not a missing shop). Moved into
  // the Ready to Import step (Roster Changes group) — now a real blocking
  // gate, same as every other panel here; no longer deferred to the
  // Success screen.
  const missingShops = useMemo(() => {
    if (moduleKind !== 'opening') return [];
    const uploadedCodes = new Set(rows.map((row) => (row.agentName ?? '').trim().toLowerCase()));
    return existingRoster.filter((entry) => !uploadedCodes.has(entry.agentCode.trim().toLowerCase()));
  }, [moduleKind, existingRoster, rows]);
  // Every missing shop needs an explicit Keep or Mark Inactive decision —
  // 'keep' now counts as a real resolved decision for gating purposes
  // (previously just a client-side acknowledgment with nothing to gate,
  // back when this panel was non-blocking on the Success screen).
  const missingShopsResolved = useMemo(
    () => missingShops.every((shop) => missingShopDecisions[shop.agentCode.trim().toLowerCase()] !== undefined),
    [missingShops, missingShopDecisions]
  );

  // Everything NOT going into this import — actively-erroring rows, every
  // duplicate that hasn't been explicitly decided 'import' yet (an
  // undecided duplicate isn't ready to go in any more than an unresolved
  // error is — it only joins readyRows once the user actually says
  // "import anyway"), plus anything the user explicitly Skipped (even if
  // since fixed, since Skip is a deliberate standalone choice, not undone
  // by editing). This is what actually determines the excludedRows list
  // sent to the server (see handleGenericImportStart/
  // handleOpeningImportStart) AND what datesNeedingConfirmation below is
  // built from — a row that isn't really going in shouldn't hold up (or
  // count toward) a date confirmation either.
  const excludedRowNumbers = useMemo(() => {
    const set = new Set<number>(skippedRows);
    reviewRowGroups.forEach((group) => { if (group.hasError && !group.skipped) set.add(group.row); });
    duplicateOnlyRowGroups.forEach((group) => {
      if (!group.skipped && duplicateDecisions[group.row] !== 'import') set.add(group.row);
    });
    newShopRowGroups.forEach((group) => {
      const decision = newShopDecisions[group.row];
      if (!(decision?.action === 'insert' && decision.leader.trim() !== '')) set.add(group.row);
    });
    return set;
  }, [skippedRows, reviewRowGroups, duplicateOnlyRowGroups, duplicateDecisions, newShopRowGroups, newShopDecisions]);

  const readyRows = useMemo(() => rows.filter((row) => !excludedRowNumbers.has(row.row)), [rows, excludedRowNumbers]);
  const readyTotalAmount = useMemo(() => readyRows.reduce((sum, row) => sum + parseAmount(getRowAmount(row)), 0), [readyRows, getRowAmount]);

  // Phase 10 "Need Validation" — distinct dates among the rows that would
  // actually be imported, excluding whichever is today's business date.
  // Settlement/Top Up only (Opening rows have no transaction date at all).
  // Compared as raw M/D/YYYY calendar components, never via Date.getTime()
  // — parseImportDate's "M/D/YYYY" branch builds a LOCAL-timezone Date,
  // while getBusinessToday() is Manila-anchored; those two instants only
  // line up if the runtime's own local timezone happens to be Manila. Going
  // through manilaFields() on both sides sidesteps that mismatch entirely.
  const datesNeedingConfirmation = useMemo(() => {
    if (moduleKind === 'opening') return [];
    const today = manilaFields(getBusinessToday());
    // Keyed by normalized Y-M-D components, NOT the raw uploaded string —
    // the same calendar date can arrive as different raw strings across
    // rows in one file (e.g. an Excel serial normalized one way for most
    // rows vs. a plain "8/15/2026" string for another), and grouping by
    // the raw string alone was silently splitting one real date into
    // multiple line items with the count spread across them. `date` below
    // is just one representative raw string (the first one seen for that
    // calendar day) used for display via formatDateForEdit — `key` is
    // what actually identifies the group everywhere else (confirmedDates,
    // the checkbox, React's own list key).
    const byDate = new Map<string, { date: string; count: number }>();
    readyRows.forEach((row) => {
      const raw = (row.date ?? '').trim();
      if (!raw) return;
      const parsed = parseImportDate(raw);
      if (!parsed) return;
      const isToday = parsed.getFullYear() === today.year && parsed.getMonth() === today.month && parsed.getDate() === today.day;
      if (isToday) return;
      const key = `${parsed.getFullYear()}-${parsed.getMonth()}-${parsed.getDate()}`;
      const existing = byDate.get(key);
      byDate.set(key, { date: existing?.date ?? raw, count: (existing?.count ?? 0) + 1 });
    });
    return Array.from(byDate.entries())
      .map(([key, { date, count }]) => ({ key, date, count }))
      .sort((a, b) => (parseImportDate(a.date)?.getTime() ?? 0) - (parseImportDate(b.date)?.getTime() ?? 0));
  }, [moduleKind, readyRows]);
  const allDatesConfirmed = datesNeedingConfirmation.every((d) => confirmedDates.has(d.key));

  // Presentational-only progress simulation for the real POST paths below —
  // the server responds once, in one shot, with no per-row signal, so
  // importDone can't reflect real per-row completion the way the legacy
  // mockImportRecords path does. This ticks importDone up toward 90% of
  // the expected total while the request is in flight (never claims
  // completion before it actually happens), then finishImportProgress
  // snaps it to 100% and holds briefly once the real response arrives.
  // Ticks toward 90% of `total` over a roughly constant real-world
  // duration (~3.5s) regardless of file size — was a fixed +1 unit/tick,
  // which meant a small file (Cashout, ~3,700 rows) reached 1% in ~4s
  // (fine) while a large one (Send Money, ~12,700 rows) took ~15s to reach
  // just 1% and ~2.5min to reach 10%, looking permanently "stuck" even
  // though the real backend import (after the bulk-update fix in
  // importOpeningFile) now finishes in ~3-4s regardless of product/row
  // count — confirmed by direct profiling against the real DB. Step size
  // scales with total so the simulated crawl's pace tracks how fast the
  // real import actually completes, instead of file size.
  const startImportProgress = useCallback((total: number) => {
    if (importProgressTimerRef.current) clearInterval(importProgressTimerRef.current);
    const cap = Math.ceil(total * 0.9);
    const targetTicks = Math.ceil(IMPORT_PROGRESS_TARGET_MS / IMPORT_PROGRESS_TICK_MS);
    const step = Math.max(1, Math.ceil(cap / targetTicks));
    importProgressTimerRef.current = setInterval(() => {
      setImportDone((current) => (current < cap ? Math.min(current + step, cap) : current));
    }, IMPORT_PROGRESS_TICK_MS);
  }, []);

  const stopImportProgress = useCallback(() => {
    if (importProgressTimerRef.current) {
      clearInterval(importProgressTimerRef.current);
      importProgressTimerRef.current = null;
    }
  }, []);

  const finishImportProgress = useCallback(async (total: number) => {
    stopImportProgress();
    setImportDone(total);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }, [stopImportProgress]);

  // Opening module: real PostgreSQL write (Phase 4) — POSTs the original
  // uploaded file to the existing /api/v2/import/opening route (already
  // built, already transactional; see importOpeningFile() in
  // importService.ts). Server re-parses and re-validates the file bytes
  // from scratch — the same "server is the final authority, never trust
  // the client" rule Phase 2's Estimated Opening upload already follows,
  // and the same reason in-modal row edits here are preview-only and not
  // resubmitted (identical to how Estimate Mode's own review step already
  // works, not a new limitation introduced by this wiring).
  // Settlement/Top Up are unchanged — still the mock path, out of scope
  // for this phase.
  const handleOpeningImportStart = useCallback(async () => {
    if (!file || !estimateApiBasePath) return;
    setStep('importing');
    setImportDone(0);
    setImportError(null);
    const product = estimateApiBasePath.includes('sendmoney') ? 'sendmoney' : 'cashout';
    startImportProgress(readyRows.length);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('product', product);
      formData.append('uploadedBy', 'Operations Admin');
      // Row numbers the user explicitly Skipped (e.g. a flagged duplicate
      // agent) — the server still parses and validates the full original
      // file, this only trims what it actually writes. See excludedRowNumbers.
      formData.append('excludedRows', JSON.stringify(Array.from(skippedRows)));
      // New Shops confirmation (see newShopsConfirmed) — every row that
      // matched no existing agent already has an explicit decision by the
      // time Continue is reachable, sent as-is; importOpeningFile mirrors
      // this exact shape (NewShopDecision) server-side.
      formData.append('newShopDecisions', JSON.stringify(newShopDecisions));
      // SDP-change confirmation (see sdpChangesConfirmed) — rows the user
      // chose Skip for still import normally, just without their SDP figure
      // overwritten; importOpeningFile leaves that column untouched for
      // these row numbers.
      const sdpSkipRows = sdpChangeRowGroups.filter((row) => sdpChangeDecisions[row.row] === 'skip').map((row) => row.row);
      formData.append('sdpSkipRows', JSON.stringify(sdpSkipRows));
      // TEMPORARY perf-verification instrumentation — remove once the
      // server-side bulk-update fix is confirmed. Covers upload + full
      // server processing as one wall-clock number; the server's own
      // console.time breakdown (importService.ts) shows where inside that
      // time actually goes.
      console.time('[Opening] upload+import round-trip');
      const res = await fetch('/api/v2/import/opening', { method: 'POST', body: formData });
      console.timeEnd('[Opening] upload+import round-trip');
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(result?.error || 'Import failed.');
      }
      await finishImportProgress(readyRows.length);
      setImportCompletedAt(new Date());
      setStep('complete');
      onImported?.();
    } catch (err) {
      stopImportProgress();
      setImportError(err instanceof Error ? err.message : 'Import failed.');
      setStep('validation');
    }
  }, [file, estimateApiBasePath, onImported, skippedRows, newShopDecisions, sdpChangeRowGroups, sdpChangeDecisions, readyRows.length, startImportProgress, finishImportProgress, stopImportProgress]);

  // Phase 7 — Settlement/Top Up's real write, generalized from
  // handleOpeningImportStart above rather than duplicating it: same
  // form-data/POST/error-handling shape, just against whichever
  // importApiBasePath the caller wired up (opening keeps its own dedicated
  // branch below since its endpoint is derived differently and predates
  // this generic prop pair).
  const handleGenericImportStart = useCallback(async () => {
    if (!file || !importApiBasePath || !product) return;
    setStep('importing');
    setImportDone(0);
    setImportError(null);
    startImportProgress(readyRows.length);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('product', product);
      formData.append('uploadedBy', 'Operations Admin');
      formData.append('excludedRows', JSON.stringify(Array.from(skippedRows)));
      const res = await fetch(importApiBasePath, { method: 'POST', body: formData });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(result?.error || 'Import failed.');
      }
      await finishImportProgress(readyRows.length);
      setImportCompletedAt(new Date());
      setStep('complete');
      onImported?.();
    } catch (err) {
      stopImportProgress();
      setImportError(err instanceof Error ? err.message : 'Import failed.');
      setStep('validation');
    }
  }, [file, importApiBasePath, product, onImported, skippedRows, readyRows.length, startImportProgress, finishImportProgress, stopImportProgress]);

  const handleImportStart = useCallback(() => {
    if (moduleKind === 'opening') {
      void handleOpeningImportStart();
      return;
    }
    if (importApiBasePath && product) {
      void handleGenericImportStart();
      return;
    }
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
  }, [readyRows.length, moduleKind, handleOpeningImportStart, importApiBasePath, product, handleGenericImportStart]);

  // Real network write — unlike handleImportStart above, this is not a mock.
  // Same request shape as the old standalone UploadExcelModal's own
  // handleImportData.
  const handleEstimateImportStart = useCallback(async () => {
    if (!estimateParsed || !file || !estimateApiBasePath) return;
    setStep('importing');
    setEstimateImportProgress(0);
    setEstimateImportError(null);

    // No real progress events from the server (single request/response) —
    // simulate a climb to 90% while in flight, then complete to 100% once
    // the response actually arrives.
    estimateProgressTimerRef.current = setInterval(() => {
      setEstimateImportProgress((current) => (current >= 90 ? current : current + Math.random() * 12));
    }, 250);

    try {
      const res = await fetch(`${estimateApiBasePath}/upload-estimated-balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...estimateParsed, fileName: file.name }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error || 'Import failed.');
      }
      const result: { uploadedAt: string; shopCount: number } = await res.json();

      if (estimateProgressTimerRef.current) {
        clearInterval(estimateProgressTimerRef.current);
        estimateProgressTimerRef.current = null;
      }
      setEstimateImportProgress(100);

      const record: EstimateImportRecord = {
        fileName: file.name,
        shopCount: result.shopCount,
        importedAt: result.uploadedAt,
        importedBy: 'Operations Admin',
      };
      setEstimateImportResult(record);
      setLastImport(record);
      setStep('complete');
      onImported?.();
    } catch (err) {
      if (estimateProgressTimerRef.current) {
        clearInterval(estimateProgressTimerRef.current);
        estimateProgressTimerRef.current = null;
      }
      setEstimateImportError(err instanceof Error ? err.message : 'Import failed.');
      setStep('validation');
    }
  }, [estimateParsed, file, estimateApiBasePath, onImported]);

  // Opening's real template (public/templates/opening-*-template.xlsx) has
  // a non-flat layout — summary cells (Updated Time, AG Total Opening
  // Balance, etc.) living alongside the roster columns, not a plain table
  // — so it isn't safely reproducible as a simple re-uploadable sheet the
  // way Settlement/Top Up's flat templates are. Opening keeps this
  // original generic Validation Report shape; Settlement/Top Up get the
  // template-matching export below.
  const downloadOpeningReport = useCallback(() => {
    const headers = ['Row', 'Agent Name', 'Field', 'Invalid Value', 'Error Message'];
    const data = reviewEntries.map((entry) => [entry.row, entry.agent, entry.field, entry.value || '(blank)', entry.issue]);
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = [{ wch: 8 }, { wch: 20 }, { wch: 14 }, { wch: 18 }, { wch: 40 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Validation Report');
    const baseName = file?.name.replace(/\.[^.]+$/, '') ?? `${moduleKind}_import`;
    XLSX.writeFile(workbook, `${baseName}_errors.xlsx`);
  }, [reviewEntries, file, moduleKind]);

  // Settlement/Top Up — same column order/headers as the real official
  // template (confirmed directly against the .xlsx files: Settlement is
  // Brand/To Agent/Amount/Wallet/Type/Date, Top Up is Brand/Agent/Amount/
  // Wallet/Type/Date), plus one appended Issue column, so the exported
  // file can be fixed and re-uploaded as-is. Every currently-flagged row
  // is included — reviewEntries already covers both Errors-table rows AND
  // Duplicates-panel rows (pairs and cluster members alike), since it's
  // type 'error' | 'duplicate' entries only. Deliberately NOT filtered by
  // excludedRowNumbers/skippedRows: this is a snapshot of the validation
  // state ("what's wrong"), not of in-progress Skip/Import-anyway
  // decisions ("what you've decided to do about it") — a duplicate
  // decided "Import anyway" still shows up here with its Duplicate label.
  const downloadTransactionReport = useCallback(() => {
    const labelsByRow = new Map<number, string[]>();
    reviewEntries.forEach((entry) => {
      const label = issueLabel(entry);
      const existing = labelsByRow.get(entry.row) ?? [];
      if (!existing.includes(label)) existing.push(label);
      labelsByRow.set(entry.row, existing);
    });

    const flaggedRowNumbers = new Set(labelsByRow.keys());
    const exportRows = rows.filter((row) => flaggedRowNumbers.has(row.row));
    const headers = moduleKind === 'topup'
      ? ['Brand', 'Agent', 'Amount', 'Wallet', 'Type', 'Date', 'Issue']
      : ['Brand', 'To Agent', 'Amount', 'Wallet', 'Type', 'Date', 'Issue'];
    const data = exportRows.map((row) => [
      (row.brand ?? '').toUpperCase(),
      row.agentName,
      row.amount ?? '',
      row.wallet ?? '',
      moduleKind === 'topup' ? (row.type ?? '') : (row.remarks ?? ''),
      row.date ?? '',
      (labelsByRow.get(row.row) ?? []).join(', '),
    ]);

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, moduleKind === 'topup' ? 'Top Up' : 'Settlement');
    const dateSuffix = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `${moduleKind}-import-issues-${dateSuffix}.xlsx`);
  }, [reviewEntries, rows, moduleKind]);

  const downloadReport = moduleKind === 'opening' ? downloadOpeningReport : downloadTransactionReport;

  // Missing Shops — Keep is a client-side-only decision (no network call,
  // but still resolves the row for gating — see missingShopsResolved);
  // Mark Inactive PATCHes the *existing* /api/v2/opening (or sendmoney)
  // route directly — same route Edit/Bulk Edit already use, now that
  // isActive is a real OpeningFieldUpdates field (openingActionsService.ts).
  // Zero Out removed per explicit request.
  const applyMissingShopAction = useCallback(async (agentCode: string) => {
    const key = agentCode.trim().toLowerCase();
    const openingProduct = estimateApiBasePath?.includes('sendmoney') ? 'sendmoney' : 'cashout';
    setMissingShopBusy((current) => ({ ...current, [key]: true }));
    setMissingShopErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      const res = await fetch(openingProduct === 'sendmoney' ? '/api/v2/sendmoney/opening' : '/api/v2/opening', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentCodes: [agentCode], updates: { isActive: false } }),
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) throw new Error(result?.error || 'Update failed.');
      setMissingShopDecisions((current) => ({ ...current, [key]: 'inactive' }));
    } catch (err) {
      setMissingShopErrors((current) => ({ ...current, [key]: err instanceof Error ? err.message : 'Update failed.' }));
    } finally {
      setMissingShopBusy((current) => ({ ...current, [key]: false }));
    }
  }, [estimateApiBasePath]);

  const markMissingShopKept = useCallback((agentCode: string) => {
    setMissingShopDecisions((current) => ({ ...current, [agentCode.trim().toLowerCase()]: 'keep' }));
  }, []);

  // "Keep all" — every unresolved missing shop at once. Only touches rows
  // without a decision yet, same convention as the other panels' bulk
  // actions (never overwrites an already-made choice, e.g. an already
  // Mark-Inactive'd shop).
  const keepAllMissingShops = useCallback(() => {
    setMissingShopDecisions((current) => {
      const next = { ...current };
      missingShops.forEach((shop) => {
        const key = shop.agentCode.trim().toLowerCase();
        if (next[key] === undefined) next[key] = 'keep';
      });
      return next;
    });
  }, [missingShops]);

  // Export Roster Changes — one workbook covering BOTH New Shops and
  // Missing Shops (two sheets), folded together since both live under the
  // same "Roster Changes" section now. Always the FULL lists, never just
  // the visible-20 slice per panel — same "display cap ≠ detection cap"
  // convention as the Errors panel's own Export Issues Report.
  const downloadRosterChangesReport = useCallback(() => {
    const workbook = XLSX.utils.book_new();

    const newShopHeaders = ['Row', 'Agent Name', 'Opening Balance', 'SDP', 'Decision', 'Leader / Linked To'];
    const newShopData = newShopRowGroups.map((group) => {
      const sourceRow = rows.find((r) => r.row === group.row);
      const decision = newShopDecisions[group.row];
      return [
        group.row,
        group.agent,
        sourceRow?.openingBalance ?? '',
        sourceRow?.sdp ?? '',
        decision?.action === 'insert' ? 'New Shop' : decision?.action === 'link' ? 'Linked to Existing' : '',
        decision?.action === 'insert' ? decision.leader : decision?.action === 'link' ? decision.agentCode : '',
      ];
    });
    const newShopSheet = XLSX.utils.aoa_to_sheet([newShopHeaders, ...newShopData]);
    newShopSheet['!cols'] = newShopHeaders.map(() => ({ wch: 20 }));
    XLSX.utils.book_append_sheet(workbook, newShopSheet, 'New Shops');

    const missingShopHeaders = ['Agent Name', 'Leader', 'Last Updated', 'Decision'];
    const missingShopData = missingShops.map((shop) => {
      const key = shop.agentCode.trim().toLowerCase();
      const decision = missingShopDecisions[key];
      return [
        shop.agentCode,
        shop.leader,
        shop.lastImportMatchedAt
          ? new Date(shop.lastImportMatchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          : 'Never',
        decision === 'keep' ? 'Kept' : decision === 'inactive' ? 'Marked Inactive' : '',
      ];
    });
    const missingShopSheet = XLSX.utils.aoa_to_sheet([missingShopHeaders, ...missingShopData]);
    missingShopSheet['!cols'] = missingShopHeaders.map(() => ({ wch: 20 }));
    XLSX.utils.book_append_sheet(workbook, missingShopSheet, 'Missing Shops');

    const dateSuffix = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `opening-roster-changes-${dateSuffix}.xlsx`);
  }, [newShopRowGroups, rows, newShopDecisions, missingShops, missingShopDecisions]);

  const downloadEstimateReport = useCallback(() => {
    const headers = ['Row', 'Shop Code', 'Shop Name', 'Column', 'Invalid Value', 'Error Message'];
    const data = estimateRowErrors.map((e) => [e.row, e.shopCode, e.shopName, e.column, e.value, e.message]);
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);
    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Import Errors');
    const baseName = file?.name.replace(/\.[^.]+$/, '') ?? 'upload';
    XLSX.writeFile(workbook, `${baseName}_errors.xlsx`);
  }, [estimateRowErrors, file]);

  // Nothing to import (every row errored/skipped/duplicate-skipped out) is
  // never allowed through, even once every other gate is satisfied — a
  // real "0 records imported successfully" completion is more confusing
  // than just blocking it up front.
  const canContinue = estimateMode
    ? (estimateParsed !== null && estimateDetectedShops > 0)
    : (activeErrorCount === 0 && duplicatesConfirmed && sdpChangesConfirmed && newShopsConfirmed && missingShopsResolved && allDatesConfirmed && readyRows.length > 0);
  const hasNonBlockingIssues = (summary?.warningCount ?? 0) + (summary?.duplicateCount ?? 0) > 0;

  const importedTimestampLabel = importCompletedAt
    ? importCompletedAt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

  // Enter confirms the current step's primary action — skipped when focus
  // is already on a button (native Enter-activates-button already covers
  // that case) so this never double-fires.
  const primaryAction = useMemo(() => {
    if (step === 'validation' && canContinue) return estimateMode ? handleEstimateImportStart : handleImportStart;
    if (step === 'complete') return requestClose;
    return null;
  }, [step, canContinue, estimateMode, handleEstimateImportStart, handleImportStart, requestClose]);

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
  // Estimate Mode replaces this slot's generic Note with the real Last
  // Import record — same footprint, no extra height, per explicit "render it
  // in the same area where Note normally appears" instruction. Hidden on
  // 'complete' same as the Note always was (that screen shows its own fresh
  // copy of the same info).
  // Only meaningful for the 'validation' step's own Note text — true when
  // there's nothing left to review at all (no errors, no undecided/
  // unconfirmed duplicates, no unconfirmed dates).
  const validationIsFullyClean = !estimateMode && activeErrorCount === 0 && duplicateOnlyRowGroups.length === 0 && datesNeedingConfirmation.length === 0;

  const footerNote = step !== 'complete' ? (
    estimateMode && lastImport ? (
      <div className="min-w-0 flex-1 pr-4">
        <p className="mb-1 text-[10px] font-semibold text-muted-foreground">Last Import:</p>
        <EstimateLastImportRow record={lastImport} />
      </div>
    ) : (
      <div className="min-w-0 flex-1 pr-4">
        <p className="text-[10px] font-semibold text-muted-foreground">Note:</p>
        <p className="text-[10px] leading-snug text-muted-foreground">
          {step === 'validation' && validationIsFullyClean
            ? 'This file passed all checks and is ready to import.'
            : 'Only validated records will be imported. Please review warnings and errors before proceeding.'}
        </p>
      </div>
    )
  ) : <div />;

  return (
    <>
      {createPortal(
        <div
          data-product={dataProduct}
          className={MODAL_OVERLAY_CLASS(closing)}
          onClick={requestClose}
        >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Bulk Import ${moduleLabel}`}
        onClick={(event) => event.stopPropagation()}
        className={MODAL_WIDE_CARD_CLASS(closing)}
      >
        <div className="flex items-start justify-between gap-3 p-6 pb-0">
          <div className="flex items-center gap-2.5">
            <span className={MODAL_GLYPH_CLASS} style={MODAL_GLYPH_STYLE}>
              {step === 'importing' ? <RefreshCw size={16} className="animate-spin" /> : <Upload size={16} />}
            </span>
            <div>
              <h2 className="text-[16px] font-bold text-foreground">Bulk Import {moduleLabel}</h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {{
                  upload: 'Upload a spreadsheet to begin.',
                  scanning: 'Scanning your file...',
                  validation: 'Review the results before importing.',
                  importing: "Importing your records — please don't close this window.",
                  complete: 'Your records have been imported.',
                }[step]}
              </p>
            </div>
          </div>
          <button type="button" onClick={requestClose} aria-label="Close" className={MODAL_CLOSE_BUTTON_CLASS}>
            <X size={14} />
          </button>
        </div>

        {/* Step indicator — hidden on the final success screen, which
            replaces the whole review UI with its own dedicated layout. */}
        {step !== 'complete' && (
          <div className="flex items-center gap-2 px-6 pb-4 pt-3.5">
            {WIZARD_STEPS.map((label, i) => {
              const status = i < activeStepIndex ? 'done' : i === activeStepIndex ? 'active' : 'upcoming';
              // Step 3's own label swaps to "Importing..." while that step
              // is actually running — "Ready to Import" the rest of the
              // time (upcoming, or the active validation step itself).
              const displayLabel = i === WIZARD_STEPS.length - 1 && step === 'importing' ? 'Importing...' : label;
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
                    <span className={`whitespace-nowrap text-[12.5px] font-semibold ${status === 'upcoming' ? 'text-muted-foreground' : 'text-foreground'}`}>
                      {displayLabel}
                    </span>
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
              {allowEstimateMode && (
                <label className={`mb-2.5 flex cursor-pointer items-start gap-3 rounded-[14px] border p-3.5 transition-colors ${
                  estimateMode ? 'border-[color:var(--product-accent)] bg-[color:var(--product-accent-soft)]' : 'border-border bg-muted/20 hover:border-muted-foreground/40'
                }`}>
                  <input
                    type="checkbox"
                    checked={estimateMode}
                    onChange={(event) => setEstimateMode(event.target.checked)}
                    className="mt-0.5 h-[18px] w-[18px] shrink-0 rounded-[5px] border-border accent-[color:var(--product-accent)]"
                  />
                  <div className="min-w-0">
                    <p className="text-[13px] font-bold text-foreground">Estimate Opening Balance</p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                      Upload a raw Balance Limit export to generate the next day&apos;s Opening Balance.
                    </p>
                  </div>
                </label>
              )}

              {!estimateMode && (
                <div className="mb-3.5 flex items-center justify-between gap-3 rounded-[14px] border border-border bg-muted/20 p-3.5">
                  <p className="text-[13px] font-semibold text-foreground">Need the official template?</p>
                  <button
                    type="button"
                    onClick={() => downloadTemplate(templateModule)}
                    className="flex shrink-0 items-center gap-1.5 rounded-[9px] border border-border bg-white px-3 py-2 text-[12px] font-semibold text-foreground transition-colors hover:border-muted-foreground/40 dark:bg-transparent"
                  >
                    <Download size={13} />
                    Download Latest Template
                  </button>
                </div>
              )}

              <div
                onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
                onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
                onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`flex h-[130px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed px-4 text-center transition-colors ${
                  dragActive ? 'border-[color:var(--product-accent)] bg-[color:var(--product-accent-soft)]' : 'border-border bg-muted/20 hover:border-[color:var(--product-accent)] hover:bg-[color:var(--product-accent-soft)]'
                }`}
              >
                <span className={MODAL_GLYPH_CLASS} style={MODAL_GLYPH_STYLE}>
                  <Upload size={17} />
                </span>
                <p className="mt-1 text-[13.5px] font-bold text-foreground">Drag &amp; drop your Excel file here</p>
                <p className="text-[11.5px] text-muted-foreground">
                  or click to browse · Supports {estimateMode ? 'Balance Limit export' : TEMPLATE_LABEL[templateModule]} (.xlsx)
                </p>
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
                    className="h-full rounded-full bg-[color:var(--product-accent)] transition-all duration-200 ease-out"
                    style={{ width: `${((scanMessageIndex + 1) / SCAN_MESSAGES.length) * 100}%` }}
                  />
                </div>
              </div>
              <p key={scanMessageIndex} className="dt-fade-in text-[13px] font-medium text-foreground">
                {SCAN_MESSAGES[scanMessageIndex]}
              </p>
            </div>
          )}

          {step === 'validation' && estimateMode && (
            <div>
              {/* File Information — same bar as Normal Mode, generalized to
                  the estimate's own detected-shops count instead of
                  summary.totalRows. */}
              <div className="flex items-center gap-3 rounded-[14px] border border-border bg-muted/20 p-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
                  <FileSpreadsheet size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-foreground">{file?.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {file ? (file.size / 1024).toFixed(0) : 0} KB · {estimateDetectedShops} rows · Modified {file ? new Date(file.lastModified).toLocaleDateString() : ''}
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

              {/* Detected — Shops / Ready / Errors. Bad rows
                  are silently excluded at import time (no per-row Edit/Skip
                  here, unlike Normal Mode) — matches the old standalone
                  UploadExcelModal's own behavior exactly. */}
              <p className="mt-3 text-[11px] font-semibold text-muted-foreground">Detected</p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div className="flex items-center gap-2 rounded-[14px] border border-border p-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                    <Store size={14} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[15px] font-bold tabular-nums text-foreground">{estimateDetectedShops.toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">Shops</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-[14px] border border-border p-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                    <CheckCircle2 size={14} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[15px] font-bold tabular-nums text-foreground">{(estimateDetectedShops - estimateDetectedErrors).toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">Ready</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { if (estimateDetectedErrors > 0) setEstimateErrorsExpanded((v) => !v); }}
                  disabled={estimateDetectedErrors === 0}
                  className={`flex items-center gap-2 rounded-[14px] border border-border p-2.5 text-left transition-colors ${
                    estimateDetectedErrors > 0 ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default'
                  }`}
                >
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    estimateDetectedErrors === 0
                      ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                      : 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
                  }`}>
                    {estimateDetectedErrors === 0 ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-bold tabular-nums text-foreground">{estimateDetectedErrors}</p>
                    <p className="text-[10px] text-muted-foreground">Errors</p>
                  </div>
                  {estimateDetectedErrors > 0 && (
                    estimateErrorsExpanded
                      ? <ChevronUp size={13} className="shrink-0 text-muted-foreground" />
                      : <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
                  )}
                </button>
              </div>

              {estimateDetectedErrors > 0 && estimateErrorsExpanded && (
                <div className="mt-3 overflow-hidden rounded-[14px] border border-border">
                  <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-2">
                    <p className="text-[11px] text-muted-foreground">
                      The following rows were skipped during import because of validation errors.
                    </p>
                    <button
                      type="button"
                      onClick={downloadEstimateReport}
                      className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      <Download size={11} />
                      Download Error Report (.xlsx)
                    </button>
                  </div>
                  <div className="max-h-[208px] overflow-auto">
                    <table className="w-full border-collapse text-[10px]">
                      <thead className="sticky top-0 z-10 bg-white shadow-[0_2px_2px_-1px_rgba(0,0,0,0.15)] dark:bg-[#2a2a2d]">
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
                        {estimateRowErrors.map((e, i) => (
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

              {estimateImportError && (
                <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-400">
                  <AlertCircle size={13} className="shrink-0" />
                  {estimateImportError}
                </div>
              )}
            </div>
          )}

          {step === 'validation' && !estimateMode && summary && (
            <div>
              {/* File Information — Total Amount lives here now (right-
                  aligned), not as its own stat card, matching the reference
                  layout. */}
              <div className="flex items-center gap-3 rounded-[14px] border border-border bg-muted/20 p-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
                  <FileSpreadsheet size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-foreground">{file?.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {file ? (file.size / 1024).toFixed(0) : 0} KB · {summary.totalRows} rows · Modified {file ? new Date(file.lastModified).toLocaleDateString() : ''}
                  </p>
                </div>
                <div className="shrink-0 border-l border-border pl-3 text-right">
                  <p className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                    <Wallet size={11} /> Total Amount
                  </p>
                  <p className="truncate text-[13px] font-bold text-foreground">{formatCompactAmount(readyTotalAmount)}</p>
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

              {/* Compact stat cards — Total Records / Ready / [Duplicates,
                  only when present] / [New Shops, Opening only, only when
                  present] / Errors. These are mutually exclusive and always
                  sum to Total Records: Errors takes priority for any row
                  that has one (even if it's ALSO a duplicate — see
                  errorRowGroups/IssueBadge), Duplicates is every
                  duplicate-only row regardless of its Skip/Import decision,
                  New Shops is every unmatched-Agent-Name row regardless of
                  its insert/link decision, Ready is everything else. This is
                  a DISPLAY-only partition for these cards — it's
                  deliberately different from readyRows/readyTotalAmount
                  below (the real set that actually gets imported), where a
                  duplicate decided "Import anyway" DOES count as ready to
                  import; it just doesn't move out of this card's Duplicates
                  bucket (same for a resolved New Shop). */}
              <div className={`mt-2.5 grid gap-2 ${
                duplicateOnlyRowGroups.length > 0 && newShopRowGroups.length > 0
                  ? 'grid-cols-5'
                  : duplicateOnlyRowGroups.length > 0 || newShopRowGroups.length > 0
                  ? 'grid-cols-4'
                  : 'grid-cols-3'
              }`}>
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
                    <p className="text-[14px] font-bold tabular-nums text-foreground">{(summary.totalRows - activeErrorCount - duplicateOnlyRowGroups.length - newShopRowGroups.length).toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">Ready</p>
                  </div>
                </div>
                {duplicateOnlyRowGroups.length > 0 && (
                  <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/50 p-1.5 dark:border-amber-500/20 dark:bg-amber-500/10">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400">
                      <AlertTriangle size={12} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[14px] font-bold tabular-nums text-amber-700 dark:text-amber-400">{duplicateOnlyRowGroups.length}</p>
                      <p className="text-[10px] text-amber-700/90 dark:text-amber-400/80">Duplicates</p>
                    </div>
                  </div>
                )}
                {newShopRowGroups.length > 0 && (
                  <div className="flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50/50 p-1.5 dark:border-indigo-500/20 dark:bg-indigo-500/10">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-400">
                      <UserPlus size={12} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[14px] font-bold tabular-nums text-indigo-700 dark:text-indigo-400">{newShopRowGroups.length}</p>
                      <p className="text-[10px] text-indigo-700/90 dark:text-indigo-400/80">New Shops</p>
                    </div>
                  </div>
                )}
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

              {/* Data Issues / Roster Changes grouping — Opening only, since
                  Settlement/Top Up have nothing that would ever populate a
                  second "Roster Changes" section (New Shops/SDP Changes/
                  Missing Shops are all Opening-only) — showing an empty
                  second group there would be pointless, so those modules
                  keep the ungrouped layout exactly as before. */}
              {moduleKind === 'opening' && (
                <ReviewSectionHeader icon={AlertTriangle} label="Data Issues" subtitle="Fix or skip before importing" />
              )}

              {/* Single combined export, shared by the Errors table AND the
                  Duplicates panel below — lives here, outside both, so it's
                  visible regardless of which panel(s) are actually present
                  (previously nested inside the Errors panel only, so a
                  duplicates-only file had no export at all). Covers every
                  currently-flagged row (errorRowGroups ∪
                  duplicateOnlyRowGroups — i.e. any reviewRowGroup with a
                  real issue), independent of Skip/Import-anyway decisions:
                  a snapshot of what's wrong, not what's been decided about
                  it. Hidden entirely on a fully clean file. */}
              {(errorRowGroups.length > 0 || duplicateOnlyRowGroups.length > 0) && (() => {
                // Data Issues = Errors + Duplicates + SDP Changes (SDP is
                // Opening-only; sdpChangesConfirmed is vacuously true for
                // Settlement/Top Up, where sdpChangeRowGroups is always
                // empty, so this has no effect there). Disabled once every
                // row across all three is resolved — nothing outstanding
                // left to export for offline review — not a one-way lock,
                // re-enables the moment any row goes back to unresolved.
                const dataIssuesResolved = activeErrorCount === 0 && allDuplicatesDecided && sdpChangesConfirmed;
                return (
                  <button
                    type="button"
                    onClick={downloadReport}
                    disabled={dataIssuesResolved}
                    className={`mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border py-2 text-[12px] font-semibold transition-colors ${
                      dataIssuesResolved
                        ? 'cursor-not-allowed border-border text-muted-foreground opacity-50'
                        : 'border-border text-foreground hover:bg-muted'
                    }`}
                  >
                    <ListChecks size={13} />
                    Export Issues Report (.xlsx)
                  </button>
                );
              })()}

              {/* Adaptive colored summary card — green when nothing's still
                  blocking, red otherwise. The panel itself (and its
                  chevron) stays reachable whenever there's ANYTHING to
                  review — including rows that are Skipped but no longer
                  actually invalid — so Restore is never stranded behind a
                  hidden panel. */}
              <div className={`mt-2.5 overflow-hidden rounded-[14px] border ${
                activeErrorCount > 0 ? 'border-rose-200 dark:border-rose-500/20' : 'border-emerald-200 dark:border-emerald-500/20'
              }`}>
                <button
                  type="button"
                  onClick={() => { if (errorRowGroups.length > 0) setIssuesExpanded((current) => !current); }}
                  disabled={errorRowGroups.length === 0}
                  className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors ${
                    activeErrorCount > 0
                      ? 'bg-rose-50 hover:bg-rose-100 dark:bg-rose-500/10 dark:hover:bg-rose-500/15'
                      : 'bg-emerald-50 dark:bg-emerald-500/10'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {activeErrorCount > 0
                      ? <AlertTriangle size={15} className="shrink-0 text-rose-600 dark:text-rose-400" />
                      : <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />}
                    <span>
                      <span className={`block text-[13px] font-bold ${activeErrorCount > 0 ? 'text-rose-800 dark:text-rose-400' : 'text-emerald-800 dark:text-emerald-400'}`}>
                        {activeErrorCount > 0
                          ? `${errorRowGroups.length} row${errorRowGroups.length === 1 ? '' : 's'} need${errorRowGroups.length === 1 ? 's' : ''} attention`
                          : 'No validation errors found'}
                      </span>
                      <span className={`block text-[11px] ${activeErrorCount > 0 ? 'text-rose-700 dark:text-rose-400/80' : 'text-emerald-700 dark:text-emerald-400/80'}`}>
                        {activeErrorCount > 0
                          ? `Fix via Edit, or skip to exclude from import (${activeErrorCount} unresolved)`
                          : 'This file is ready to import.'}
                      </span>
                    </span>
                  </span>
                  {errorRowGroups.length > 0 && (
                    issuesExpanded
                      ? <ChevronUp size={15} className={`shrink-0 ${activeErrorCount > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`} />
                      : <ChevronDown size={15} className={`shrink-0 ${activeErrorCount > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`} />
                  )}
                </button>

                {/* Not rendered at all when there's nothing to review (per
                    spec: "Hide it completely if validation passes") — the
                    grid-template-rows 0fr/1fr trick below only handles the
                    smooth expand/collapse animation, it doesn't hide
                    content that's otherwise mounted. */}
                {errorRowGroups.length > 0 && (
                <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                  issuesExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                }`}>
                  <div className="overflow-hidden">
                    <div className={`border-t ${activeErrorCount > 0 ? 'border-rose-200 dark:border-rose-500/20' : 'border-emerald-200 dark:border-emerald-500/20'}`}>
                      {/* Quick action — outside the scroll area, always
                          visible. Skip All acts on every unresolved error
                          row, including ones beyond the 20-row display cap
                          below, which are never individually reachable
                          otherwise. */}
                      {activeErrorCount > 0 && (
                        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-4 py-1.5">
                          <span className="text-[10px] text-muted-foreground">
                            Quick action for all {errorRowGroups.length} row{errorRowGroups.length === 1 ? '' : 's'}
                          </span>
                          <button
                            type="button"
                            onClick={() => skipRows(errorRowGroups.filter((group) => !group.skipped).map((group) => group.row))}
                            className="rounded-md border border-border px-2 py-1 text-[10px] font-semibold text-foreground transition-colors hover:bg-muted"
                          >
                            Skip All
                          </button>
                        </div>
                      )}
                      {/* Card list, not a table — matches the Duplicates
                          panel's own row style. Sized to use the space
                          actually available under a fixed-height modal (not
                          an arbitrary small cap) — keeps its own scroll for
                          anything beyond that, instead of pushing the whole
                          step tall enough to need the outer content area to
                          scroll too. Capped at the first 20 rows — a file
                          with a large error count relies on Skip All /
                          Export above/below, not scrolling through
                          hundreds of mounted rows. */}
                      <div className="max-h-[280px] divide-y divide-border overflow-y-auto">
                        {errorRowGroups.slice(0, 20).map((group) => {
                          // One badge per distinct ISSUE LABEL (not just per
                          // type) — a row with two different error fields
                          // gets two different badges, not one generic
                          // "Error" pill; de-duped via the label itself so
                          // the same label never renders twice.
                          const distinctIssues = Array.from(
                            new Map(group.issues.map((issue) => [issueLabel(issue), issue])).values()
                          );
                          return (
                            <div
                              key={group.row}
                              className={`flex items-center gap-3 px-4 py-2 transition-opacity ${group.skipped ? 'opacity-50' : ''}`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <p className="truncate text-[13px] font-medium text-foreground">{group.agent}</p>
                                  {group.skipped
                                    ? <SkippedBadge />
                                    : distinctIssues.map((issue) => <IssueBadge key={issueLabel(issue)} entry={issue} />)}
                                </div>
                                <p className="mt-0.5 text-[11px] text-muted-foreground">
                                  Row {group.row} · {displayNum(parseAmount(group.amount))} · {group.wallet}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => toggleSkip(group.row)}
                                  className={`rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                                    group.skipped
                                      ? 'border-foreground bg-foreground text-white dark:border-white dark:bg-white dark:text-[#1c1c1e]'
                                      : 'border-border text-muted-foreground hover:bg-muted'
                                  }`}
                                >
                                  {group.skipped ? 'Restore' : 'Skip'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingRowNumber(group.row)}
                                  aria-label={`Edit row ${group.row}`}
                                  title="Edit"
                                  className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                >
                                  <Pencil size={13} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {errorRowGroups.length > 20 && (
                        <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                          Showing 20 of {errorRowGroups.length} flagged rows. Export the report to review the rest, or use Skip All to exclude every unresolved error from this import.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                )}
              </div>

              {/* Duplicates panel — separate from the Errors table above.
                  Every row here needs an explicit Skip/Import-anyway
                  decision (no silent default) before Continue enables; see
                  duplicatesConfirmed. */}
              {duplicateOnlyRowGroups.length > 0 ? (
                <div className={`mt-2.5 overflow-hidden rounded-[14px] border ${allDuplicatesDecided ? 'border-emerald-200 dark:border-emerald-500/20' : 'border-amber-200 dark:border-amber-500/20'}`}>
                  <button
                    type="button"
                    onClick={() => setDuplicatesPanelOpen((current) => !current)}
                    className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors ${
                      allDuplicatesDecided
                        ? 'bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:hover:bg-emerald-500/15'
                        : 'bg-amber-50 hover:bg-amber-100 dark:bg-amber-500/10 dark:hover:bg-amber-500/15'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      {allDuplicatesDecided
                        ? <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                        : <Copy size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />}
                      <span>
                        <span className={`block text-[13px] font-bold ${allDuplicatesDecided ? 'text-emerald-800 dark:text-emerald-400' : 'text-amber-800 dark:text-amber-400'}`}>
                          {allDuplicatesDecided && '✓ '}{duplicateOnlyRowGroups.length} possible duplicate{duplicateOnlyRowGroups.length === 1 ? '' : 's'} found
                        </span>
                        <span className={`block text-[11px] ${allDuplicatesDecided ? 'text-emerald-700 dark:text-emerald-400/80' : 'text-amber-700 dark:text-amber-400/80'}`}>
                          {allDuplicatesDecided
                            ? `${duplicateOnlyRowGroups.length} of ${duplicateOnlyRowGroups.length} resolved — review the summary below`
                            : `Decide for each row before importing (${duplicateOnlyRowGroups.filter((g) => duplicateDecisions[g.row] !== undefined).length}/${duplicateOnlyRowGroups.length} resolved)`}
                        </span>
                      </span>
                    </span>
                    {duplicatesPanelOpen
                      ? <ChevronUp size={15} className={`shrink-0 ${allDuplicatesDecided ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`} />
                      : <ChevronDown size={15} className={`shrink-0 ${allDuplicatesDecided ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`} />}
                  </button>

                  {/* Same grid-template-rows expand/collapse technique as
                      the Errors panel above, instead of a plain mount/
                      unmount — smoothly animated open/close either way. */}
                  <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                    duplicatesPanelOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  }`}>
                  <div className="overflow-hidden">
                    <div className="border-t border-amber-200 bg-white dark:border-amber-500/20 dark:bg-[#2a2a2d]">
                      {/* Quick actions — outside the scroll area, always visible. */}
                      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-4 py-1.5">
                        <span className="text-[10px] text-muted-foreground">
                          Quick action for all {duplicateOnlyRowGroups.length} row{duplicateOnlyRowGroups.length === 1 ? '' : 's'}
                        </span>
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => applyDuplicateDecisionToAll('skip', duplicateOnlyRowGroups.map((g) => g.row))}
                            className="rounded-md border border-border px-2 py-1 text-[10px] font-semibold text-foreground transition-colors hover:bg-muted"
                          >
                            Skip all
                          </button>
                          <button
                            type="button"
                            onClick={() => applyDuplicateDecisionToAll('import', duplicateOnlyRowGroups.map((g) => g.row))}
                            className="rounded-md border border-[color:var(--product-accent)] px-2 py-1 text-[10px] font-semibold text-[color:var(--product-accent)] transition-colors hover:bg-[color:var(--product-accent-soft)]"
                          >
                            Import all anyway
                          </button>
                        </div>
                      </div>

                      {/* Cluster list — caps at ~5 rows of height, then
                          scrolls internally, so the modal itself doesn't
                          grow unbounded on a file with many duplicates. */}
                      <div className="max-h-[320px] divide-y divide-border overflow-y-auto">
                        {duplicateClusters.map((cluster) => {
                          if (cluster.rows.length <= 2) {
                            return cluster.rows.map((row) => {
                              const decision = duplicateDecisions[row.row];
                              const partner = cluster.rows.find((r) => r.row !== row.row);
                              const alreadyImported = alreadyImportedMatchByRow.get(row.row);
                              return (
                                <div key={row.row} className="flex items-center gap-3 px-4 py-2">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <p className="truncate text-[13px] font-medium text-foreground">{row.agent}</p>
                                      <IssueBadge entry={DUPLICATE_BADGE_ENTRY} />
                                    </div>
                                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                                      {moduleKind === 'opening'
                                        ? `Row ${row.row}${row.leader ? ` · ${row.leader}` : ''}`
                                        : `Row ${row.row} · ${displayNum(parseAmount(row.amount))} · ${row.wallet} · ${row.type}`}
                                    </p>
                                    {/* A row can have both an in-file partner AND an
                                        already-imported match — two different findings,
                                        both shown, still just one Duplicate badge/one
                                        blocking decision above. */}
                                    {partner && (
                                      <p className="mt-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">Matches Row {partner.row} exactly.</p>
                                    )}
                                    {alreadyImported && (
                                      <p className="mt-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                        Already imported on {formatDateForEdit(row.date)} at {formatManilaClockTime(new Date(alreadyImported.importedAt))}, by {alreadyImported.importedBy}.
                                      </p>
                                    )}
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => setDuplicateDecision(row.row, 'skip')}
                                      className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                                        decision === 'skip'
                                          ? 'border-foreground bg-foreground text-white shadow-sm dark:border-white dark:bg-white dark:text-[#1c1c1e]'
                                          : 'border-border bg-white text-muted-foreground hover:bg-muted dark:bg-transparent'
                                      }`}
                                    >
                                      {decision === 'skip' && <Check size={11} className="shrink-0" />}
                                      Skip
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setDuplicateDecision(row.row, 'import')}
                                      className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                                        decision === 'import'
                                          ? 'border-[color:var(--product-accent)] bg-[color:var(--product-accent)] text-white shadow-sm'
                                          : 'border-border bg-white text-muted-foreground hover:bg-muted dark:bg-transparent'
                                      }`}
                                    >
                                      {decision === 'import' && <Check size={11} className="shrink-0" />}
                                      Import anyway
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setEditingRowNumber(row.row)}
                                      aria-label={`Edit row ${row.row}`}
                                      title="Edit"
                                      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                      <Pencil size={13} />
                                    </button>
                                  </div>
                                </div>
                              );
                            });
                          }

                          // 3+ rows match exactly — one collapsed cluster
                          // card. The Skip all/Import all pair sets every
                          // row in the cluster at once; each row ALSO gets
                          // its own Skip/Import so one row can be pulled out
                          // of an otherwise-imported cluster (or vice versa)
                          // without re-deciding the whole group. Edit stays
                          // per-row too, since fixing one row doesn't fix
                          // the others.
                          const clusterRowNumbers = cluster.rows.map((r) => r.row);
                          const clusterDecision = clusterRowNumbers.every((r) => duplicateDecisions[r] === 'skip')
                            ? 'skip'
                            : clusterRowNumbers.every((r) => duplicateDecisions[r] === 'import')
                            ? 'import'
                            : undefined;
                          return (
                            <div key={cluster.signature} className="px-3 py-2.5">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-[12px] font-semibold text-foreground">
                                    {cluster.rows.length} rows match exactly
                                  </p>
                                  <p className="truncate text-[11px] text-muted-foreground">
                                    Rows {clusterRowNumbers.join(', ')} · {cluster.rows[0].agent}
                                  </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => applyDuplicateDecisionToAll('skip', clusterRowNumbers)}
                                    className={`rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                                      clusterDecision === 'skip'
                                        ? 'border-foreground bg-foreground text-white dark:border-white dark:bg-white dark:text-[#1c1c1e]'
                                        : 'border-border text-muted-foreground hover:bg-muted'
                                    }`}
                                  >
                                    Skip all {cluster.rows.length}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => applyDuplicateDecisionToAll('import', clusterRowNumbers)}
                                    className={`rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                                      clusterDecision === 'import'
                                        ? 'border-[color:var(--product-accent)] bg-[color:var(--product-accent)] text-white'
                                        : 'border-border text-muted-foreground hover:bg-muted'
                                    }`}
                                  >
                                    Import all {cluster.rows.length}
                                  </button>
                                </div>
                              </div>
                              <div className="mt-2 space-y-1">
                                {cluster.rows.map((row) => {
                                  const decision = duplicateDecisions[row.row];
                                  const alreadyImported = alreadyImportedMatchByRow.get(row.row);
                                  return (
                                    <div key={row.row} className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2 py-1.5">
                                      <span className="truncate text-[11px] text-muted-foreground">
                                        {moduleKind === 'opening'
                                          ? `Row ${row.row}${row.leader ? ` · ${row.leader}` : ''}`
                                          : `Row ${row.row} · ${displayNum(parseAmount(row.amount))}`}
                                        {alreadyImported && <span className="text-amber-600 dark:text-amber-400"> · Already imported</span>}
                                      </span>
                                      <div className="flex shrink-0 items-center gap-1">
                                        <button
                                          type="button"
                                          onClick={() => setDuplicateDecision(row.row, 'skip')}
                                          className={`rounded-md border px-2 py-1 text-[10.5px] font-semibold transition-colors ${
                                            decision === 'skip'
                                              ? 'border-foreground bg-foreground text-white shadow-sm dark:border-white dark:bg-white dark:text-[#1c1c1e]'
                                              : 'border-border bg-white text-muted-foreground hover:bg-muted dark:bg-transparent'
                                          }`}
                                        >
                                          Skip
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setDuplicateDecision(row.row, 'import')}
                                          className={`rounded-md border px-2 py-1 text-[10.5px] font-semibold transition-colors ${
                                            decision === 'import'
                                              ? 'border-[color:var(--product-accent)] bg-[color:var(--product-accent)] text-white shadow-sm'
                                              : 'border-border bg-white text-muted-foreground hover:bg-muted dark:bg-transparent'
                                          }`}
                                        >
                                          Import
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setEditingRowNumber(row.row)}
                                          aria-label={`Edit row ${row.row}`}
                                          title={`Edit Row ${row.row}`}
                                          className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                        >
                                          <Pencil size={11} />
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  </div>
                </div>
              ) : (
                <ClearStatusBanner text="No duplicates found. This file is ready to import." />
              )}

              {/* SDP Changes Need Review — Opening only, part of the Data
                  Issues group. Soft confirmation (Confirm/Skip), same as
                  New Shops/Missing Shops — Skip does NOT exclude the row
                  from import, it only tells the server to leave that one
                  shop's SDP column untouched (see sdpSkipRows in
                  handleOpeningImportStart); Opening Balance and everything
                  else on the row still applies normally. */}
              {moduleKind === 'opening' && (
                sdpChangeRowGroups.length > 0 ? (
                  <div className={`mt-2.5 overflow-hidden rounded-[14px] border ${sdpChangesConfirmed ? 'border-emerald-200 dark:border-emerald-500/20' : 'border-amber-200 dark:border-amber-500/20'}`}>
                    <button
                      type="button"
                      onClick={() => setSdpChangesPanelOpen((current) => !current)}
                      className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors ${
                        sdpChangesConfirmed
                          ? 'bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:hover:bg-emerald-500/15'
                          : 'bg-amber-50 hover:bg-amber-100 dark:bg-amber-500/10 dark:hover:bg-amber-500/15'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {sdpChangesConfirmed
                          ? <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                          : <AlertTriangle size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />}
                        <span>
                          <span className={`block text-[13px] font-bold ${sdpChangesConfirmed ? 'text-emerald-800 dark:text-emerald-400' : 'text-amber-800 dark:text-amber-400'}`}>
                            {sdpChangesConfirmed && '✓ '}{sdpChangeRowGroups.length} SDP change{sdpChangeRowGroups.length === 1 ? '' : 's'} need{sdpChangeRowGroups.length === 1 ? 's' : ''} review
                          </span>
                          <span className={`block text-[11px] ${sdpChangesConfirmed ? 'text-emerald-700 dark:text-emerald-400/80' : 'text-amber-700 dark:text-amber-400/80'}`}>
                            {sdpChangesConfirmed
                              ? `${sdpChangeRowGroups.length} of ${sdpChangeRowGroups.length} resolved`
                              : 'Confirm each large change, or Skip to keep the previous SDP value for that shop.'}
                          </span>
                        </span>
                      </span>
                      {sdpChangesPanelOpen
                        ? <ChevronUp size={15} className={`shrink-0 ${sdpChangesConfirmed ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`} />
                        : <ChevronDown size={15} className={`shrink-0 ${sdpChangesConfirmed ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`} />}
                    </button>
                    <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                      sdpChangesPanelOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                    }`}>
                      <div className="overflow-hidden">
                        <div className="max-h-[320px] divide-y divide-border overflow-y-auto border-t border-amber-200 bg-white dark:border-amber-500/20 dark:bg-[#2a2a2d]">
                          {sdpChangeRowGroups.map((row) => {
                            const decision = sdpChangeDecisions[row.row];
                            const pctLabel = `${row.newSdp >= row.prevSdp ? '+' : '-'}${Math.round(row.pctChange * 100)}%`;
                            return (
                              <div key={row.row} className="flex items-center justify-between gap-3 px-4 py-2">
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-[13px] font-medium text-foreground">{row.agent}</p>
                                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                                    Row {row.row} · {displayNum(row.prevSdp)} → {displayNum(row.newSdp)} ({pctLabel})
                                  </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => setSdpChangeDecisions((current) => ({ ...current, [row.row]: 'skip' }))}
                                    className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                                      decision === 'skip'
                                        ? 'border-foreground bg-foreground text-white shadow-sm dark:border-white dark:bg-white dark:text-[#1c1c1e]'
                                        : 'border-border bg-white text-muted-foreground hover:bg-muted dark:bg-transparent'
                                    }`}
                                  >
                                    {decision === 'skip' && <Check size={11} className="shrink-0" />}
                                    Skip
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setSdpChangeDecisions((current) => ({ ...current, [row.row]: 'confirm' }))}
                                    className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                                      decision === 'confirm'
                                        ? 'border-[color:var(--product-accent)] bg-[color:var(--product-accent)] text-white shadow-sm'
                                        : 'border-border bg-white text-muted-foreground hover:bg-muted dark:bg-transparent'
                                    }`}
                                  >
                                    {decision === 'confirm' && <Check size={11} className="shrink-0" />}
                                    Confirm
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <ClearStatusBanner text="No large SDP changes detected." />
                )
              )}

              {/* Roster Changes group — New Shops + Missing Shops, moved
                  into this same Ready to Import step (Missing Shops used to
                  live on the Success screen, non-blocking — superseded: it's
                  a real blocking decision now, same pattern as everything
                  else here). One combined export for both, inline with the
                  header itself (no divider on this header — matches the
                  reference mockup exactly, a deliberately different layout
                  from Data Issues' header). */}
              {moduleKind === 'opening' && (() => {
                // Roster Changes = New Shops + Missing Shops. .every() on an
                // empty array is vacuously true, so this one condition
                // already covers both cases the button needs to disable
                // for: nothing there at all, AND everything there already
                // resolved — no separate "is there anything" check needed.
                // Live/reactive, not a one-way lock: flips back the moment
                // a row becomes unresolved again.
                const rosterChangesResolved = newShopsConfirmed && missingShopsResolved;
                return (
                  <ReviewSectionHeader
                    icon={Layers}
                    label="Roster Changes"
                    subtitle="Who's joining or missing from this upload"
                    trailing={
                      <button
                        type="button"
                        onClick={downloadRosterChangesReport}
                        disabled={rosterChangesResolved}
                        className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors ${
                          rosterChangesResolved
                            ? 'cursor-not-allowed border-border text-muted-foreground opacity-50'
                            : 'border-border text-foreground hover:bg-muted'
                        }`}
                      >
                        <ListChecks size={11} />
                        Export Roster Changes (.xlsx)
                      </button>
                    }
                  />
                );
              })()}

              {/* New Shops — Opening only. A row whose Agent Name matches
                  nothing in the current roster needs an explicit decision
                  before Continue enables (same hard gate as Errors/
                  Duplicates, confirmed): either a real new shop (Leader
                  required, resolved via find-or-create same as everywhere
                  else in the app) or a link onto an existing shop this row
                  was actually meant to update (the typo/variant case). Bulk
                  "Confirm all as new shops" below covers the "Yes, new
                  shop" side only (using each row's own Leader from the
                  file) — "No — matches existing" still needs a specific
                  shop picked per row, no sensible bulk form of that. */}
              {moduleKind === 'opening' && (
                newShopRowGroups.length > 0 ? (
                  <div className={`mt-2.5 overflow-hidden rounded-[14px] border ${newShopsConfirmed ? 'border-emerald-200 dark:border-emerald-500/20' : 'border-indigo-200 dark:border-indigo-500/20'}`}>
                    <button
                      type="button"
                      onClick={() => setNewShopsPanelOpen((current) => !current)}
                      className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors ${
                        newShopsConfirmed
                          ? 'bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:hover:bg-emerald-500/15'
                          : 'bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:hover:bg-indigo-500/15'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {newShopsConfirmed
                          ? <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                          : <UserPlus size={15} className="shrink-0 text-indigo-600 dark:text-indigo-400" />}
                        <span>
                          <span className={`block text-[13px] font-bold ${newShopsConfirmed ? 'text-emerald-800 dark:text-emerald-400' : 'text-indigo-800 dark:text-indigo-400'}`}>
                            {newShopsConfirmed && '✓ '}{newShopRowGroups.length} new shop{newShopRowGroups.length === 1 ? '' : 's'} detected in this file
                          </span>
                          <span className={`block text-[11px] ${newShopsConfirmed ? 'text-emerald-700 dark:text-emerald-400/80' : 'text-indigo-700 dark:text-indigo-400/80'}`}>
                            {newShopsConfirmed
                              ? `${newShopRowGroups.length} of ${newShopRowGroups.length} resolved`
                              : 'Confirm each one, or link it to an existing shop if this is a typo/variant.'}
                          </span>
                        </span>
                      </span>
                      {newShopsPanelOpen
                        ? <ChevronUp size={15} className={`shrink-0 ${newShopsConfirmed ? 'text-emerald-700 dark:text-emerald-400' : 'text-indigo-700 dark:text-indigo-400'}`} />
                        : <ChevronDown size={15} className={`shrink-0 ${newShopsConfirmed ? 'text-emerald-700 dark:text-emerald-400' : 'text-indigo-700 dark:text-indigo-400'}`} />}
                    </button>
                    <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                      newShopsPanelOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                    }`}>
                      <div className="overflow-hidden">
                        <div className="border-t border-indigo-200 bg-white dark:border-indigo-500/20 dark:bg-[#2a2a2d]">
                          {/* Quick action — outside the scroll area, always
                              visible, same pattern as Duplicates' Skip
                              all/Import all anyway bar. Only "Yes, new
                              shop" bulk-applies; a row with no Leader in
                              the file is left exactly as-is (no decision
                              written), still visibly unresolved below. */}
                          {(() => {
                            const blankLeaderCount = newShopRowGroups.filter(
                              (group) => !(rows.find((r) => r.row === group.row)?.leader ?? '').trim()
                            ).length;
                            const confirmedInsertCount = newShopRowGroups.filter((group) => {
                              const d = newShopDecisions[group.row];
                              return d?.action === 'insert' && d.leader.trim() !== '';
                            }).length;
                            return (
                              <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-4 py-1.5">
                                <span className="text-[10px] text-muted-foreground">
                                  {blankLeaderCount > 0
                                    ? `${confirmedInsertCount} confirmed, ${blankLeaderCount} still need${blankLeaderCount === 1 ? 's' : ''} a Leader assigned`
                                    : `Quick action for all ${newShopRowGroups.length} row${newShopRowGroups.length === 1 ? '' : 's'}`}
                                </span>
                                <button
                                  type="button"
                                  onClick={confirmAllNewShopsAsNew}
                                  disabled={blankLeaderCount === newShopRowGroups.length}
                                  className="rounded-md border border-[color:var(--product-accent)] px-2 py-1 text-[10px] font-semibold text-[color:var(--product-accent)] transition-colors hover:bg-[color:var(--product-accent-soft)] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  Confirm all as new shops
                                </button>
                              </div>
                            );
                          })()}
                          <div className="max-h-[320px] divide-y divide-border overflow-y-auto">
                          {/* Capped at the first 20 rows — same convention
                              as Errors/Missing Shops, a file with hundreds
                              or thousands of new shops relies on the bulk
                              action/Export above, not scrolling through
                              every mounted row. The cap is display-only:
                              confirmAllNewShopsAsNew and
                              downloadRosterChangesReport both already
                              operate on the full, unsliced
                              newShopRowGroups. */}
                          {newShopRowGroups.slice(0, 20).map((group) => {
                            const sourceRow = rows.find((r) => r.row === group.row);
                            const decision = newShopDecisions[group.row];
                            return (
                              <div key={group.row} className="px-4 py-2">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-[13px] font-medium text-foreground">{group.agent}</p>
                                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                                      Row {group.row} · Opening {displayNum(parseAmount(sourceRow?.openingBalance ?? ''))} · SDP {displayNum(parseAmount(sourceRow?.sdp ?? ''))}
                                    </p>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => setNewShopDecisions((current) => ({ ...current, [group.row]: { action: 'link', agentCode: '' } }))}
                                      className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                                        decision?.action === 'link'
                                          ? 'border-foreground bg-foreground text-white shadow-sm dark:border-white dark:bg-white dark:text-[#1c1c1e]'
                                          : 'border-border bg-white text-muted-foreground hover:bg-muted dark:bg-transparent'
                                      }`}
                                    >
                                      {decision?.action === 'link' && <Check size={11} className="shrink-0" />}
                                      No — matches existing
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setNewShopDecisions((current) => {
                                        const existing = current[group.row];
                                        const leader = existing?.action === 'insert' ? existing.leader : (sourceRow?.leader ?? '');
                                        return { ...current, [group.row]: { action: 'insert', leader } };
                                      })}
                                      className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                                        decision?.action === 'insert'
                                          ? 'border-[color:var(--product-accent)] bg-[color:var(--product-accent)] text-white shadow-sm'
                                          : 'border-border bg-white text-muted-foreground hover:bg-muted dark:bg-transparent'
                                      }`}
                                    >
                                      {decision?.action === 'insert' && <Check size={11} className="shrink-0" />}
                                      Yes, new shop
                                    </button>
                                  </div>
                                </div>
                                {decision?.action === 'insert' && (
                                  <div className="mt-2">
                                    <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Leader</label>
                                    <SearchableCombobox
                                      value={decision.leader}
                                      onChange={(value) => setNewShopDecisions((current) => ({ ...current, [group.row]: { action: 'insert', leader: value } }))}
                                      options={leaderOptions}
                                      allowCustom
                                      placeholder="Select or type a Leader"
                                    />
                                    {!decision.leader.trim() && (
                                      <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">Leader is required before this shop can be confirmed.</p>
                                    )}
                                  </div>
                                )}
                                {decision?.action === 'link' && (
                                  <div className="mt-2">
                                    <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Matches which existing shop?</label>
                                    <SearchableCombobox
                                      value={decision.agentCode}
                                      onChange={(value) => setNewShopDecisions((current) => ({ ...current, [group.row]: { action: 'link', agentCode: value } }))}
                                      options={existingRosterAgentCodes}
                                      placeholder="Search existing shops"
                                    />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          </div>
                          {newShopRowGroups.length > 20 && (
                            <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
                              Showing 20 of {newShopRowGroups.length} new shops. Export Roster Changes to review the rest.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <ClearStatusBanner text="No new shops detected. Every row matches an existing shop." />
                )
              )}

              {/* Missing Shops — moved here from the Success screen (was
                  non-blocking/post-import; now a real blocking decision,
                  same as every other panel in this step). Full-set
                  detection unchanged: scan-time roster minus every
                  agentCode appearing anywhere in the uploaded file. Own
                  distinct panel, never merged with New Shops. */}
              {moduleKind === 'opening' && (
                missingShops.length > 0 ? (
                  <div className={`mt-2.5 overflow-hidden rounded-[14px] border ${missingShopsResolved ? 'border-emerald-200 dark:border-emerald-500/20' : 'border-indigo-200 dark:border-indigo-500/20'}`}>
                    <button
                      type="button"
                      onClick={() => setMissingShopsPanelOpen((current) => !current)}
                      className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors ${
                        missingShopsResolved
                          ? 'bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:hover:bg-emerald-500/15'
                          : 'bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:hover:bg-indigo-500/15'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {missingShopsResolved
                          ? <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                          : <UserMinus size={15} className="shrink-0 text-indigo-600 dark:text-indigo-400" />}
                        <span>
                          <span className={`block text-[13px] font-bold ${missingShopsResolved ? 'text-emerald-800 dark:text-emerald-400' : 'text-indigo-800 dark:text-indigo-400'}`}>
                            {missingShopsResolved && '✓ '}{missingShops.length} shop{missingShops.length === 1 ? '' : 's'} from your records weren&apos;t in this file
                          </span>
                          <span className={`block text-[11px] ${missingShopsResolved ? 'text-emerald-700 dark:text-emerald-400/80' : 'text-indigo-700 dark:text-indigo-400/80'}`}>
                            {missingShopsResolved
                              ? `${missingShops.length} of ${missingShops.length} resolved`
                              : 'Choose what to do with each before Continue.'}
                          </span>
                        </span>
                      </span>
                      {missingShopsPanelOpen
                        ? <ChevronUp size={15} className={`shrink-0 ${missingShopsResolved ? 'text-emerald-700 dark:text-emerald-400' : 'text-indigo-700 dark:text-indigo-400'}`} />
                        : <ChevronDown size={15} className={`shrink-0 ${missingShopsResolved ? 'text-emerald-700 dark:text-emerald-400' : 'text-indigo-700 dark:text-indigo-400'}`} />}
                    </button>
                    <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                      missingShopsPanelOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                    }`}>
                      <div className="overflow-hidden">
                        <div className="border-t border-indigo-200 bg-white dark:border-indigo-500/20 dark:bg-[#2a2a2d]">
                          <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-4 py-1.5">
                            <span className="text-[10px] text-muted-foreground">
                              Quick action for all {missingShops.length} shop{missingShops.length === 1 ? '' : 's'}
                            </span>
                            <button
                              type="button"
                              onClick={keepAllMissingShops}
                              className="rounded-md border border-[color:var(--product-accent)] px-2 py-1 text-[10px] font-semibold text-[color:var(--product-accent)] transition-colors hover:bg-[color:var(--product-accent-soft)]"
                            >
                              Keep all
                            </button>
                          </div>
                          <div className="max-h-[280px] divide-y divide-border overflow-y-auto">
                            {missingShops.slice(0, 20).map((shop) => {
                              const key = shop.agentCode.trim().toLowerCase();
                              const decision = missingShopDecisions[key];
                              const busy = missingShopBusy[key] ?? false;
                              const error = missingShopErrors[key];
                              const lastUpdatedLabel = shop.lastImportMatchedAt
                                ? new Date(shop.lastImportMatchedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                                : 'never';
                              return (
                                <div
                                  key={shop.agentCode}
                                  className={`flex items-center justify-between gap-3 px-4 py-2 transition-opacity ${decision === 'inactive' ? 'opacity-50' : ''}`}
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-[13px] font-medium text-foreground">{shop.agentCode}</p>
                                    <p className="mt-0.5 text-[11px] text-muted-foreground">Last updated: {lastUpdatedLabel}</p>
                                    {error && <p className="mt-1 text-[10px] text-rose-600 dark:text-rose-400">{error}</p>}
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    {decision === 'inactive' ? (
                                      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                                        <UserMinus size={10} className="shrink-0" />
                                        Inactive
                                      </span>
                                    ) : decision === 'keep' ? (
                                      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400">
                                        <Check size={10} className="shrink-0" />
                                        Kept
                                      </span>
                                    ) : (
                                      <>
                                        <button
                                          type="button"
                                          disabled={busy}
                                          onClick={() => markMissingShopKept(shop.agentCode)}
                                          className="rounded-md border border-[color:var(--product-accent)] bg-[color:var(--product-accent)] px-2 py-1.5 text-[11px] font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
                                        >
                                          Keep
                                        </button>
                                        <button
                                          type="button"
                                          disabled={busy}
                                          onClick={() => applyMissingShopAction(shop.agentCode)}
                                          className="rounded-md border border-border bg-white px-2 py-1.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50 dark:bg-transparent"
                                        >
                                          Mark Inactive
                                        </button>
                                        {busy && <span className="text-[10px] text-muted-foreground">Saving…</span>}
                                      </>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          {missingShops.length > 20 && (
                            <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
                              Showing 20 of {missingShops.length} missing shops. Export Roster Changes to review the rest.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <ClearStatusBanner text="No shops missing from today's file." />
                )
              )}

              {datesNeedingConfirmation.length > 0 ? (
                <div className="mt-2.5 overflow-hidden rounded-[14px] border border-amber-200 dark:border-amber-500/20">
                  <div className="flex items-start gap-2 bg-amber-50 px-3 py-2 dark:bg-amber-500/10">
                    <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <div>
                      <p className="text-[12px] font-semibold text-amber-700 dark:text-amber-400">
                        Date confirmation needed
                      </p>
                      <p className="text-[11px] text-amber-600/90 dark:text-amber-400/80">
                        {datesNeedingConfirmation.length === 1
                          ? "1 date in this file isn't today — confirm it's correct before importing."
                          : `${datesNeedingConfirmation.length} dates in this file aren't today — confirm each is correct before importing.`}
                      </p>
                    </div>
                  </div>
                  <div className="divide-y divide-border border-t border-amber-200 dark:border-amber-500/20">
                    {datesNeedingConfirmation.map(({ key, date, count }) => {
                      const confirmed = confirmedDates.has(key);
                      return (
                        <label
                          key={key}
                          className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 transition-colors hover:bg-muted/30"
                        >
                          <span className="text-[12px] text-foreground">
                            <span className="font-semibold">{formatDateForEdit(date)}</span>
                            <span className="text-muted-foreground"> — {count} row{count === 1 ? '' : 's'}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={confirmed}
                              onChange={(e) => {
                                setConfirmedDates((current) => {
                                  const next = new Set(current);
                                  if (e.target.checked) next.add(key); else next.delete(key);
                                  return next;
                                });
                              }}
                              className="h-3.5 w-3.5 rounded border-border accent-[color:var(--product-accent)]"
                            />
                            <span className={`text-[11px] font-medium ${confirmed ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                              {confirmed ? 'Confirmed' : 'Is this correct?'}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : moduleKind !== 'opening' && rows.length > 0 ? (
                <ClearStatusBanner text="All dates match today. No confirmation needed." />
              ) : null}

              {importError && (
                <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-400">
                  <AlertCircle size={13} className="shrink-0" />
                  {importError}
                </div>
              )}
            </div>
          )}

          {step === 'importing' && estimateMode && (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-[13px] font-semibold text-foreground">Importing data...</p>
              <p className="text-[12px] text-muted-foreground">This may take a few seconds.</p>
              <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-[color:var(--product-accent)] transition-all duration-300 ease-out"
                  style={{ width: `${Math.min(estimateImportProgress, 100)}%` }}
                />
              </div>
              <p className="text-[11px] font-semibold tabular-nums text-foreground">{Math.round(Math.min(estimateImportProgress, 100))}%</p>
            </div>
          )}

          {step === 'importing' && !estimateMode && summary && (
            <div className="flex h-full flex-col items-center justify-center py-14 text-center">
              <div className="mb-6 h-16 w-16 animate-spin rounded-full border-4 border-[color:var(--product-accent-soft)] border-t-[color:var(--product-accent)]" />
              <p className="mb-1 text-[13px] font-bold text-foreground">
                Importing {importDone} of {readyRows.length} record{readyRows.length === 1 ? '' : 's'}...
              </p>
              <p className="mb-5 text-[12px] text-muted-foreground">This usually takes a few seconds.</p>
              <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-[color:var(--product-accent)] transition-all duration-150 ease-out"
                  style={{ width: `${readyRows.length ? (importDone / readyRows.length) * 100 : 0}%` }}
                />
              </div>
              <p className="mt-2 text-[11px] font-semibold tabular-nums text-[color:var(--product-accent)]">
                {readyRows.length ? Math.round((importDone / readyRows.length) * 100) : 0}%
              </p>
            </div>
          )}

          {step === 'complete' && estimateMode && estimateImportResult && (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <div className="rounded-[14px] bg-emerald-50 p-5 text-center dark:bg-emerald-500/10">
                <div className="mx-auto flex h-[52px] w-[52px] items-center justify-center rounded-full bg-emerald-50 text-emerald-600 shadow-[0_4px_14px_-2px_rgba(16,185,129,0.35)] dark:bg-emerald-500/15 dark:text-emerald-400">
                  <CheckCircle2 size={22} />
                </div>
                <p className="mt-3 text-[14px] font-bold text-foreground">Opening Balance imported successfully!</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{estimateImportResult.shopCount} shops imported.</p>
              </div>
              <div className="grid w-full grid-cols-3 gap-3">
                <div className="min-w-0">
                  <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                    <FileText size={12} className="shrink-0" />
                    File Name
                  </p>
                  <p className="mt-1 truncate text-[12px] font-medium text-foreground">{estimateImportResult.fileName}</p>
                </div>
                <div className="min-w-0">
                  <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                    <User size={12} className="shrink-0" />
                    Imported By
                  </p>
                  <p className="mt-1 truncate text-[12px] font-medium text-foreground">{estimateImportResult.importedBy}</p>
                </div>
                <div className="min-w-0">
                  <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                    <Clock size={12} className="shrink-0" />
                    Imported At
                  </p>
                  <p className="mt-1 truncate text-[12px] font-medium text-foreground">{formatImportTimestamp(estimateImportResult.importedAt)}</p>
                </div>
              </div>
            </div>
          )}

          {step === 'complete' && !estimateMode && summary && (() => {
            const duplicatesImportedCount = duplicateOnlyRowGroups.filter((g) => duplicateDecisions[g.row] === 'import').length;
            const duplicatesSkippedCount = duplicateOnlyRowGroups.filter((g) => duplicateDecisions[g.row] === 'skip').length;
            const errorsSkippedCount = errorRowGroups.filter((g) => g.skipped).length;
            return (
              <div className="flex h-full flex-col items-center pt-2 text-center">
                <div className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-emerald-50 text-emerald-600 shadow-[0_4px_14px_-2px_rgba(16,185,129,0.35)] dark:bg-emerald-500/15 dark:text-emerald-400">
                  <CheckCircle2 size={22} />
                </div>
                <p className="mt-3 text-[15px] font-bold text-foreground">
                  {readyRows.length.toLocaleString()} record{readyRows.length === 1 ? '' : 's'} imported successfully
                </p>
                {(duplicatesImportedCount > 0 || errorsSkippedCount > 0) && (
                  <p className="mt-1 max-w-sm text-[12px] text-muted-foreground">
                    {duplicatesImportedCount > 0 && (
                      <>Includes {duplicatesImportedCount} duplicate{duplicatesImportedCount !== 1 ? 's' : ''} imported per your confirmation. </>
                    )}
                    {errorsSkippedCount > 0 && (
                      <>{errorsSkippedCount} error row{errorsSkippedCount !== 1 ? 's' : ''} skipped.</>
                    )}
                  </p>
                )}
                <div className="mt-5 w-full max-w-sm divide-y divide-border overflow-hidden rounded-[14px] border border-border text-left">
                  <div className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-[12px] text-muted-foreground">Total imported</span>
                    <span className="text-[13px] font-bold tabular-nums text-foreground">{readyRows.length.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-[12px] text-muted-foreground">Skipped duplicates</span>
                    <span className="text-[13px] font-bold tabular-nums text-foreground">{duplicatesSkippedCount.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-[12px] text-muted-foreground">Skipped errors</span>
                    <span className="text-[13px] font-bold tabular-nums text-foreground">{errorsSkippedCount.toLocaleString()}</span>
                  </div>
                </div>

              </div>
            );
          })()}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border p-6 pt-4">
          {step === 'upload' && (
            <>
              {footerNote}
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={requestClose} className={MODAL_GHOST_BUTTON_CLASS}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {step === 'scanning' && (
            <>
              {footerNote}
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" disabled className={`${MODAL_GHOST_BUTTON_CLASS} opacity-50`}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {step === 'validation' && (
            <>
              {footerNote}
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={resetWizardState} className={`${MODAL_GHOST_BUTTON_CLASS} inline-flex items-center gap-1`}>
                  <ChevronLeft size={13} />
                  Back
                </button>
                <button
                  type="button"
                  onClick={estimateMode ? handleEstimateImportStart : handleImportStart}
                  disabled={!canContinue}
                  // Disabled state is a real, separate flat-muted style, not
                  // the shared accent style faded via opacity — layering
                  // bg-muted/text-muted-foreground on top of
                  // accentButtonClassName's own bg-*/text-white wouldn't
                  // reliably win (Tailwind utility precedence isn't string
                  // order), so this swaps the whole className instead of
                  // trying to override it.
                  className={
                    canContinue
                      ? `${MODAL_PRIMARY_BUTTON_SHAPE_CLASS} ${accentButtonClassName}`
                      : 'inline-flex items-center gap-1.5 rounded-[10px] bg-muted px-4 py-2 text-[12px] font-semibold text-muted-foreground cursor-not-allowed'
                  }
                >
                  {!canContinue && <ChevronRight size={13} className="opacity-0" />}
                  {estimateMode
                    ? 'Import Data'
                    : activeErrorCount > 0
                    ? 'Resolve Errors'
                    : !allDuplicatesDecided
                    ? 'Resolve Duplicates'
                    : !sdpChangesConfirmed
                    ? 'Confirm SDP Changes'
                    : !newShopsConfirmed
                    ? 'Confirm New Shops'
                    : !missingShopsResolved
                    ? 'Resolve Missing Shops'
                    : !allDatesConfirmed
                    ? 'Confirm Dates'
                    : readyRows.length === 0
                    ? 'No Records to Import'
                    : hasNonBlockingIssues
                    ? 'Import Anyway'
                    : 'Import Data'}
                  {canContinue && <ChevronRight size={13} />}
                </button>
              </div>
            </>
          )}
          {step === 'importing' && (
            // No Cancel here — cancelling mid-POST isn't part of the spec,
            // and the spinner/progress step above already says what's
            // happening. Just a centered note, matching the reference's
            // own importing-step footer exactly (no buttons at all).
            <p className="w-full text-center text-[11px] text-muted-foreground">Please keep this window open...</p>
          )}
          {step === 'complete' && !estimateMode && (
            <>
              <span className="text-[11px] text-muted-foreground">{importedTimestampLabel}</span>
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={resetWizardState} className={MODAL_GHOST_BUTTON_CLASS}>
                  Import Another File
                </button>
                <button type="button" onClick={requestClose} className={`${MODAL_PRIMARY_BUTTON_SHAPE_CLASS} ${accentButtonClassName}`}>
                  <Check size={13} />
                  Done
                </button>
              </div>
            </>
          )}
          {step === 'complete' && estimateMode && (
            <>
              {footerNote}
              <div className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={resetWizardState} className={MODAL_GHOST_BUTTON_CLASS}>
                  Import Another File
                </button>
                <button type="button" onClick={requestClose} className={`${MODAL_PRIMARY_BUTTON_SHAPE_CLASS} ${accentButtonClassName}`}>
                  <Check size={13} />
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
        document.body
      )}
      <RowIssueEditModal
        isOpen={editingRowNumber !== null}
        onClose={() => setEditingRowNumber(null)}
        onSave={handleRowEditSave}
        title={`Edit Row ${editingRowNumber ?? ''}`}
        fields={importRecordFields}
        initialValues={editingInitialValues}
        primaryButtonClassName={accentButtonClassName}
        getFieldHint={getFieldHint}
        dataProduct={dataProduct}
        noticeText={editingNoticeText}
        noticeVariant={editingNoticeVariant}
        highlightedKeys={editingHighlightedKeys}
      />
    </>
  );
}
