'use client';

import { useRef, useState, type FormEvent } from 'react';
import Image from 'next/image';
import {
  User,
  Lock,
  Eye,
  EyeOff,
  ShieldCheck,
  Activity,
  KeyRound,
  Loader2,
  ArrowRight,
  AlertCircle,
} from 'lucide-react';

const BENEFITS = [
  { icon: ShieldCheck, label: 'Secure & Protected', description: 'Your data is encrypted and safe.' },
  { icon: Activity, label: 'Real-time Insights', description: 'Monitor and manage operations in real time.' },
  { icon: KeyRound, label: 'Role-Based Access', description: 'Access tools based on your permissions.' },
];

type FieldErrors = { username?: string; password?: string };

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  // A ref, not just the `loading` state, guards against duplicate submits —
  // state updates are batched/async, so a second click firing in the same
  // tick (before React re-renders `loading: true`) would otherwise still
  // read the stale `false` value and slip through.
  const submittingRef = useRef(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const nextFieldErrors: FieldErrors = {};
    if (!username.trim()) nextFieldErrors.username = 'Username is required.';
    if (!password) nextFieldErrors.password = 'Password is required.';
    setFieldErrors(nextFieldErrors);
    setFormError('');
    if (Object.keys(nextFieldErrors).length > 0) return;

    submittingRef.current = true;
    setLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, rememberMe }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setFormError(data.error || 'Invalid username or password.');
        submittingRef.current = false;
        setLoading(false);
        return;
      }
      // Hard navigation (not next/navigation's router) so middleware
      // re-evaluates the fresh session cookie on a real request rather than
      // relying on the client router cache.
      window.location.href = '/';
    } catch {
      setFormError('Something went wrong. Please try again.');
      submittingRef.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full overflow-y-auto bg-[#f4f6fb] font-[Inter,sans-serif] dark:bg-[#020617]">
      {/* Left — branding panel, hidden below md per spec (mobile keeps the
          login form as the sole focus, with a compact brand header instead). */}
      <div className="relative hidden w-full max-w-[480px] shrink-0 flex-col justify-between overflow-hidden bg-gradient-to-br from-[#0b1220] via-[#0f172a] to-[#0b1220] px-10 py-12 text-white md:flex lg:max-w-[520px]">
        {/* Subtle background details only — dot grid + two soft glows, no
            illustrations/stock imagery/heavy gradients. */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
        />
        <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -right-16 bottom-0 h-80 w-80 rounded-full bg-indigo-400/10 blur-3xl" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
        {/* "Floor grid" — a dot pattern tilted via perspective + faded via a
            mask, reading as a subtle wave/mesh rather than a flat grid. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-72 opacity-40"
          style={{
            backgroundImage: 'radial-gradient(rgba(99,102,241,0.6) 1px, transparent 1px)',
            backgroundSize: '18px 18px',
            transform: 'perspective(600px) rotateX(58deg) scale(1.8)',
            transformOrigin: 'bottom',
            maskImage: 'linear-gradient(to top, black 0%, transparent 85%)',
            WebkitMaskImage: 'linear-gradient(to top, black 0%, transparent 85%)',
          }}
        />

        <div className="dt-fade-in relative z-10">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white shadow-lg ring-1 ring-white/10">
              <Image src="/kibo-ui-light.svg" alt="" width={26} height={26} className="object-contain" unoptimized />
            </div>
            <div>
              <p className="text-[14px] font-semibold leading-tight">Operations</p>
              <p className="text-[11px] leading-snug text-slate-400">Operations Dashboard</p>
            </div>
          </div>
        </div>

        <div className="dt-fade-in relative z-10">
          <span className="inline-flex items-center rounded-full border border-indigo-400/25 bg-indigo-500/10 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-indigo-300">
            Operations Portal
          </span>

          <h1 className="mt-5 text-[36px] font-bold leading-[1.15] text-white">
            Welcome Back!
            <span className="block text-indigo-400">Let&apos;s keep operations running smoothly.</span>
          </h1>
          <p className="mt-3 max-w-[360px] text-[14px] leading-relaxed text-slate-400">
            Secure access to your operations dashboard, wallet management, and system insights.
          </p>

          <div className="mt-8 space-y-4">
            {BENEFITS.map(({ icon: Icon, label, description }) => (
              <div key={label} className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 ring-1 ring-indigo-400/30">
                  <Icon size={17} className="text-indigo-300" />
                </span>
                <div>
                  <p className="text-[13px] font-semibold text-slate-200">{label}</p>
                  <p className="text-[12px] leading-snug text-slate-500">{description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-[11px] text-slate-500">
          © {new Date().getFullYear()} Operations Dashboard. All rights reserved.
        </p>
      </div>

      {/* Right — login form */}
      <div className="flex w-full flex-1 items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-[400px]">
          {/* Mobile-only compact brand header — the left panel is hidden
              below md, this keeps the brand identity present regardless. */}
          <div className="mb-8 flex items-center justify-center gap-2.5 md:hidden">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-border">
              <Image src="/kibo-ui-light.svg" alt="" width={22} height={22} className="object-contain" unoptimized />
            </div>
            <div>
              <p className="text-[13px] font-semibold leading-tight text-foreground">Operations</p>
              <p className="text-[10px] leading-snug text-muted-foreground">Operations Dashboard</p>
            </div>
          </div>

          <div className="dt-fade-in rounded-2xl border border-border bg-white p-8 shadow-[0_10px_40px_rgba(15,23,42,0.08)] dark:bg-[#0d1117] dark:shadow-[0_10px_40px_rgba(0,0,0,0.4)]">
            <div className="mb-6 flex flex-col items-center text-center">
              <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[rgba(79,70,229,0.1)] text-[#4f46e5] dark:bg-[rgba(129,140,248,0.14)] dark:text-indigo-400">
                <Lock size={24} />
              </span>
              <h2 className="text-[20px] font-bold text-foreground">Sign In</h2>
              <p className="mt-1.5 text-[13px] text-muted-foreground">Enter your credentials to access your account.</p>
            </div>

            {formError && (
              <div role="alert" className="mb-5 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[12.5px] font-medium text-rose-700 dark:border-rose-900/50 dark:bg-rose-500/10 dark:text-rose-400">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div>
                <label htmlFor="username" className="mb-1.5 block text-[12.5px] font-semibold text-foreground">
                  Username
                </label>
                <div
                  className={`flex h-11 items-center gap-2.5 rounded-xl border bg-white px-3.5 transition-colors dark:bg-[#1c1c1e] ${
                    fieldErrors.username ? 'border-rose-300 focus-within:border-rose-400' : 'border-border focus-within:border-[#4f46e5]'
                  }`}
                >
                  <User size={16} className="shrink-0 text-muted-foreground" />
                  <input
                    id="username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    placeholder="Enter your username"
                    value={username}
                    aria-invalid={!!fieldErrors.username}
                    aria-describedby={fieldErrors.username ? 'username-error' : undefined}
                    onChange={(event) => {
                      setUsername(event.target.value);
                      if (fieldErrors.username) setFieldErrors((f) => ({ ...f, username: undefined }));
                    }}
                    className="w-full bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                </div>
                {fieldErrors.username && (
                  <p id="username-error" role="alert" className="mt-1.5 text-[12px] font-medium text-rose-600 dark:text-rose-400">
                    {fieldErrors.username}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="password" className="mb-1.5 block text-[12.5px] font-semibold text-foreground">
                  Password
                </label>
                <div
                  className={`flex h-11 items-center gap-2.5 rounded-xl border bg-white px-3.5 transition-colors dark:bg-[#1c1c1e] ${
                    fieldErrors.password ? 'border-rose-300 focus-within:border-rose-400' : 'border-border focus-within:border-[#4f46e5]'
                  }`}
                >
                  <Lock size={16} className="shrink-0 text-muted-foreground" />
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    value={password}
                    aria-invalid={!!fieldErrors.password}
                    aria-describedby={fieldErrors.password ? 'password-error' : undefined}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
                    }}
                    className="w-full bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {fieldErrors.password && (
                  <p id="password-error" role="alert" className="mt-1.5 text-[12px] font-medium text-rose-600 dark:text-rose-400">
                    {fieldErrors.password}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-medium text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(event) => setRememberMe(event.target.checked)}
                    className="h-3.5 w-3.5 cursor-pointer accent-[#4f46e5]"
                  />
                  Remember me
                </label>
                {/* Not wired to a recovery flow — the app has none yet — so
                    this stays a plain span, not a dead link/button, per
                    explicit instruction not to fake functionality. Styled
                    as a subtle blue link per the visual spec regardless. */}
                <span className="text-[12.5px] font-medium text-[#4f46e5] dark:text-indigo-400">Forgot password?</span>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-[#4f46e5] to-[#7c3aed] text-[13.5px] font-semibold text-white transition-all duration-150 ease-out hover:from-[#4338ca] hover:to-[#6d28d9] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Signing in...
                  </>
                ) : (
                  <>
                    Sign In
                    <ArrowRight size={15} />
                  </>
                )}
              </button>
            </form>

            <div className="mt-6 flex items-center justify-center gap-1.5 border-t border-border pt-5 text-[12px] text-muted-foreground dark:border-white/10">
              <ShieldCheck size={13} className="shrink-0 text-muted-foreground/70" />
              <span>
                Need help? <span className="font-medium text-[#4f46e5] dark:text-indigo-400">Contact your administrator.</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
