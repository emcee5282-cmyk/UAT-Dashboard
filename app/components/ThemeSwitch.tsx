'use client';

import { Sun, Moon } from 'lucide-react';
import { useTheme } from './ThemeProvider';

// Premium sliding icon toggle — a single switch (not two separate
// Light/Dark buttons), matching the sun-left/moon-right pill pattern common
// to modern SaaS dashboards. Track width 44px, thumb 20px, 2px inset on
// each side — thumb travels exactly 44 - 20 - 2*2 = 20px between states.
export default function ThemeSwitch() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={toggleTheme}
      className="relative flex h-6 w-11 shrink-0 items-center rounded-full border border-border bg-muted/60 p-0.5 transition-colors duration-300 ease-out hover:border-[#4f46e5]/40 dark:border-[#3a3a3d] dark:bg-white/5"
    >
      {/* Static track icons — both always present at low opacity so the
          thumb reads as "revealing" whichever one is currently active,
          rather than the icons appearing/disappearing abruptly. */}
      <Sun size={11} className="absolute left-[5px] text-amber-500/70" />
      <Moon size={11} className="absolute right-[5px] text-indigo-300" />

      {/* Thumb — slides via transform (GPU-friendly, no layout thrash),
          20px of travel, spring-ish cubic-bezier for a premium feel rather
          than linear ease. */}
      <span
        className="relative flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-[0_1px_3px_rgba(15,23,42,0.25)] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] dark:bg-[#1c1c1e]"
        style={{ transform: isDark ? 'translateX(20px)' : 'translateX(0px)' }}
      >
        <Sun
          size={12}
          className={`absolute text-amber-500 transition-all duration-200 ${isDark ? 'scale-0 rotate-90 opacity-0' : 'scale-100 rotate-0 opacity-100'}`}
        />
        <Moon
          size={12}
          className={`absolute text-indigo-400 transition-all duration-200 ${isDark ? 'scale-100 rotate-0 opacity-100' : 'scale-0 -rotate-90 opacity-0'}`}
        />
      </span>
    </button>
  );
}
