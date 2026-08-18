'use client';

import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';

type Theme = 'light' | 'dark';

type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light');

  // Preserves scroll position across a theme change — shared by toggleTheme
  // and the direct setTheme (used by the account menu's Light/Dark
  // segmented control) so neither path jumps the page.
  const preserveScroll = () => {
    if (typeof window === 'undefined') return;
    const { scrollX, scrollY } = window;
    window.requestAnimationFrame(() => {
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' });
    });
  };

  const toggleTheme = useCallback(() => {
    preserveScroll();
    setThemeState((current) => (current === 'light' ? 'dark' : 'light'));
  }, []);

  const setTheme = useCallback((nextTheme: Theme) => {
    preserveScroll();
    setThemeState(nextTheme);
  }, []);

  useEffect(() => {
    // Direct setThemeState here, not the memoized setTheme above — this is
    // the initial mount, there's no scroll position worth preserving yet.
    const savedTheme = window.localStorage.getItem('dashboard-theme');
    if (savedTheme === 'dark' || savedTheme === 'light') {
      setThemeState(savedTheme);
      return;
    }
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setThemeState(prefersDark ? 'dark' : 'light');
  }, []);

  useEffect(() => {
    window.localStorage.setItem('dashboard-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      toggleTheme,
      setTheme,
    }),
    [theme, toggleTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
