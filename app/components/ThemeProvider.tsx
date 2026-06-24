'use client';

import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';

type Theme = 'light' | 'dark';

type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('light');

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const nextTheme = current === 'light' ? 'dark' : 'light';

      if (typeof window !== 'undefined') {
        const { scrollX, scrollY } = window;
        window.requestAnimationFrame(() => {
          window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' });
        });
      }

      return nextTheme;
    });
  }, []);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem('dashboard-theme');
    if (savedTheme === 'dark' || savedTheme === 'light') {
      setTheme(savedTheme);
      return;
    }
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(prefersDark ? 'dark' : 'light');
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
    }),
    [theme, toggleTheme]
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
