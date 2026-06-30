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
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        isDark
          ? 'bg-transparent text-slate-400 hover:bg-slate-800'
          : 'bg-transparent text-slate-700 hover:bg-slate-100'
      }`}
    >
      {isDark ? <Sun size={14} strokeWidth={1.75} /> : <Moon size={13} fill="currentColor" strokeWidth={0} />}
    </button>
  );
}
