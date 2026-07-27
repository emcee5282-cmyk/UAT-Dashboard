'use client';

// Inserts thousand separators live while typing, keeping the underlying
// value as a plain digits(+one decimal point) string — no commas — so
// callers always get back something parseAmount()-compatible. Reusable
// wherever a currency amount is entered (Settlement today; Bulk Import
// validation / other modules later per spec).
function formatWithCommas(raw: string): string {
  if (!raw) return '';
  const [intPart, decPart] = raw.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart !== undefined ? `${withCommas}.${decPart}` : withCommas;
}

// Strips everything except digits and a single decimal point (extra dots
// beyond the first are dropped, not just the leading one) so pasted text
// like "50,000.00abc" or "12.34.56" always resolves to a valid raw number.
function stripToRawAmount(input: string): string {
  const stripped = input.replace(/,/g, '').replace(/[^\d.]/g, '');
  const firstDot = stripped.indexOf('.');
  if (firstDot === -1) return stripped;
  return stripped.slice(0, firstDot + 1) + stripped.slice(firstDot + 1).replace(/\./g, '');
}

type AmountInputProps = {
  id?: string;
  value: string;
  onChange: (raw: string) => void;
  onBlur?: () => void;
  error?: boolean;
  placeholder?: string;
};

export default function AmountInput({ id, value, onChange, onBlur, error, placeholder = '0.00' }: AmountInputProps) {
  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      value={formatWithCommas(value)}
      onChange={(event) => onChange(stripToRawAmount(event.target.value))}
      onBlur={onBlur}
      placeholder={placeholder}
      className={`h-10 w-full rounded-lg border bg-white px-3 text-[13px] text-foreground outline-none transition-colors focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20 dark:bg-[#1c1c1e] ${
        error ? 'border-rose-400' : 'border-border'
      }`}
    />
  );
}
