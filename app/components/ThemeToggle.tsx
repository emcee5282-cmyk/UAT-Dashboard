'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from './ThemeProvider';

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`flex items-center justify-center rounded-xl border p-1.5 shadow-sm transition-all ${
        isDark
          ? 'border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'
          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
      }`}
    >
      {isDark ? <Sun size={13} /> : <Moon size={13} />}
    </button>
  );
}
