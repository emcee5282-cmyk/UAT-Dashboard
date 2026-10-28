'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { KeyRound, Eye, EyeOff, Loader2, AlertCircle, Check, Circle, ArrowLeft, LogOut, ShieldAlert } from 'lucide-react';
import { useSession } from '@/app/lib/auth/useSession';
import { PASSWORD_REUSE_RULE, PASSWORD_RULES, validatePasswordRules } from '@/app/lib/auth/passwordRules';

type Field = 'currentPassword' | 'newPassword' | 'confirmPassword';

const LABELS: Record<Field, string> = {
  currentPassword: 'Current password',
  newPassword: 'New password',
  confirmPassword: 'Confirm new password',
};
const AUTOCOMPLETE: Record<Field, string> = {
  currentPassword: 'current-password',
  newPassword: 'new-password',
  confirmPassword: 'new-password',
};

// Same standalone card layout as /login (AppShell bypasses this path), so a
// user held here by a pending first-login change never sees dashboard
// navigation they can't use yet.
export default function ChangePasswordPage() {
  const session = useSession();
  const forced = !!session?.mustChangePassword;
  const [values, setValues] = useState<Record<Field, string>>({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [visible, setVisible] = useState<Record<Field, boolean>>({ currentPassword: false, newPassword: false, confirmPassword: false });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const submittingRef = useRef(false);

  const setValue = (field: Field, value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    if (fieldErrors[field]) setFieldErrors((e) => ({ ...e, [field]: undefined }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const next: Partial<Record<Field, string>> = {};
    if (!values.currentPassword) next.currentPassword = 'Enter your current password.';
    const ruleError = validatePasswordRules(values.newPassword);
    if (ruleError) next.newPassword = ruleError;
    if (!values.confirmPassword) next.confirmPassword = 'Confirm your new password.';
    else if (values.confirmPassword !== values.newPassword) next.confirmPassword = 'New passwords do not match.';
    setFieldErrors(next);
    setFormError('');
    if (Object.keys(next).length > 0) return;

    submittingRef.current = true;
    setLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.field && data.field in LABELS) setFieldErrors({ [data.field as Field]: data.error });
        else setFormError(data.error || 'Could not change your password. Please try again.');
        if (res.status === 401) window.location.href = '/login';
        return;
      }
      setDone(true);
      // Hard navigation so the proxy re-reads the now-cleared
      // must-change flag on a real request.
      setTimeout(() => {
        window.location.href = typeof data.redirectTo === 'string' && data.redirectTo.startsWith('/') ? data.redirectTo : '/';
      }, 900);
    } catch {
      setFormError('Something went wrong. Please try again.');
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center overflow-y-auto bg-[#f4f6fb] px-4 py-12 font-[Inter,sans-serif] dark:bg-[#020617]">
      <div className="w-full max-w-[420px]">
        <div className="dt-fade-in rounded-2xl border border-border bg-white p-8 shadow-[0_10px_40px_rgba(15,23,42,0.08)] dark:bg-[#0d1117] dark:shadow-[0_10px_40px_rgba(0,0,0,0.4)]">
          <div className="mb-6 flex flex-col items-center text-center">
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[rgba(79,70,229,0.1)] text-[#4f46e5] dark:bg-[rgba(129,140,248,0.14)] dark:text-indigo-400">
              <KeyRound size={24} />
            </span>
            <h1 className="text-[20px] font-bold text-foreground">Change Password</h1>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              {session ? (
                <>
                  Signed in as <span className="font-semibold text-foreground">{session.username}</span>
                </>
              ) : (
                <span className="inline-block h-3.5 w-32 animate-pulse rounded bg-muted align-middle" />
              )}
            </p>
          </div>

          {forced && !done && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] font-medium text-amber-800 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-300">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" />
              <span>You&apos;re using a temporary password. Set your own password to continue.</span>
            </div>
          )}

          {formError && (
            <div role="alert" className="mb-5 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[12.5px] font-medium text-rose-700 dark:border-rose-900/50 dark:bg-rose-500/10 dark:text-rose-400">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          {done ? (
            <div role="status" className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-[12.5px] font-medium text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400">
              <Check size={15} className="mt-0.5 shrink-0" />
              <span>Password changed. Other devices have been signed out. Redirecting…</span>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              {(Object.keys(LABELS) as Field[]).map((field) => (
                <div key={field}>
                  <label htmlFor={field} className="mb-1.5 block text-[12.5px] font-semibold text-foreground">
                    {forced && field === 'currentPassword' ? 'Temporary password' : LABELS[field]}
                  </label>
                  <div
                    className={`flex h-11 items-center gap-2.5 rounded-xl border bg-white px-3.5 transition-colors dark:bg-[#1c1c1e] ${
                      fieldErrors[field] ? 'border-rose-300 focus-within:border-rose-400' : 'border-border focus-within:border-[#4f46e5]'
                    }`}
                  >
                    <input
                      id={field}
                      name={field}
                      type={visible[field] ? 'text' : 'password'}
                      autoComplete={AUTOCOMPLETE[field]}
                      value={values[field]}
                      aria-invalid={!!fieldErrors[field]}
                      aria-describedby={fieldErrors[field] ? `${field}-error` : undefined}
                      onChange={(event) => setValue(field, event.target.value)}
                      className="w-full bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/60"
                    />
                    <button
                      type="button"
                      onClick={() => setVisible((v) => ({ ...v, [field]: !v[field] }))}
                      aria-label={visible[field] ? 'Hide password' : 'Show password'}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {visible[field] ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  {fieldErrors[field] && (
                    <p id={`${field}-error`} role="alert" className="mt-1.5 text-[12px] font-medium text-rose-600 dark:text-rose-400">
                      {fieldErrors[field]}
                    </p>
                  )}
                </div>
              ))}

              <div className="rounded-xl border border-border bg-muted/20 px-3.5 py-3">
                <p className="mb-1.5 text-[11.5px] font-semibold text-foreground">Password rules</p>
                <ul className="space-y-1">
                  {PASSWORD_RULES.map((rule) => {
                    const ok = rule.test(values.newPassword);
                    return (
                      <li key={rule.label} className={`flex items-center gap-1.5 text-[12px] ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                        {ok ? <Check size={13} className="shrink-0" /> : <Circle size={11} className="mx-px shrink-0" />}
                        {rule.label}
                      </li>
                    );
                  })}
                  <li className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <Circle size={11} className="mx-px shrink-0" />
                    {PASSWORD_REUSE_RULE}
                  </li>
                </ul>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-[#4f46e5] to-[#7c3aed] text-[13.5px] font-semibold text-white transition-all duration-150 ease-out hover:from-[#4338ca] hover:to-[#6d28d9] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Change Password'
                )}
              </button>
            </form>
          )}

          <div className="mt-6 flex items-center justify-between border-t border-border pt-5 text-[12.5px] dark:border-white/10">
            {forced || !session ? (
              <span />
            ) : (
              <Link href="/" className="flex items-center gap-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground">
                <ArrowLeft size={14} />
                Back
              </Link>
            )}
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-1.5 font-medium text-rose-600 transition-colors hover:text-rose-700 dark:text-rose-400"
            >
              <LogOut size={14} />
              Logout
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
