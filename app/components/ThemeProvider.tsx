'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { flushSync } from 'react-dom';

type Theme = 'light' | 'dark';

type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

// Circular reveal on theme change (View Transitions API): the new theme
// grows out of the clicked toggle until it covers the viewport.
const REVEAL_MS = 550;
// A click older than this isn't treated as the toggle that started the change.
const ORIGIN_MAX_AGE_MS = 1000;
// On <html> while the theme switches — suppresses CSS transitions (globals.css).
const SWITCHING_CLASS = 'theme-switching';

type ViewTransitionLike = { ready: Promise<void>; finished: Promise<void> };
type DocumentWithViewTransition = Document & { startViewTransition?: (update: () => void) => ViewTransitionLike };

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light');
  const themeRef = useRef<Theme>('light');
  const animatingRef = useRef(false);
  // Center of the last clicked control — the toggles call toggleTheme()
  // without an event, so the origin is captured here instead.
  const originRef = useRef<{ x: number; y: number; at: number } | null>(null);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    const recordOrigin = (event: MouseEvent) => {
      const control = (event.target as Element | null)?.closest?.('button, a, label, [role="button"], [role="switch"], [role="radio"]');
      if (control) {
        const rect = control.getBoundingClientRect();
        originRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, at: Date.now() };
      } else {
        originRef.current = { x: event.clientX, y: event.clientY, at: Date.now() };
      }
    };
    document.addEventListener('click', recordOrigin, true);
    return () => document.removeEventListener('click', recordOrigin, true);
  }, []);

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

  // Commits the theme to React and <html> synchronously, with CSS
  // transitions suppressed (html.theme-switching in globals.css) so nothing
  // fades the new colors in on its own. The DOM writes match the [theme]
  // effect below — applied here too so they land before any snapshot.
  const applyThemeNow = (next: Theme) => {
    const root = document.documentElement;
    root.classList.add(SWITCHING_CLASS);
    flushSync(() => setThemeState(next));
    themeRef.current = next;
    root.classList.toggle('dark', next === 'dark');
    root.style.colorScheme = next;
  };

  // Drops the suppression class after forcing a style recalc, so the new
  // colors are already computed and removing it starts no transitions.
  const endSwitching = () => {
    const root = document.documentElement;
    void getComputedStyle(root).color;
    root.classList.remove(SWITCHING_CLASS);
  };

  // Wraps the theme state change in the circular reveal. Falls back to an
  // instant switch without the API or with reduced motion; extra clicks
  // while a reveal runs are ignored.
  const changeTheme = useCallback((next: Theme) => {
    if (animatingRef.current) return;
    if (next === themeRef.current) return;
    preserveScroll();

    const doc = document as DocumentWithViewTransition;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof doc.startViewTransition !== 'function' || reduceMotion) {
      applyThemeNow(next);
      endSwitching();
      return;
    }

    const recent = originRef.current && Date.now() - originRef.current.at < ORIGIN_MAX_AGE_MS ? originRef.current : null;
    originRef.current = null;
    const x = recent?.x ?? window.innerWidth / 2;
    const y = recent?.y ?? window.innerHeight / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    animatingRef.current = true;
    const transition = doc.startViewTransition(() => applyThemeNow(next));
    transition.ready
      .then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: REVEAL_MS, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' }
        );
      })
      .catch(() => {});
    transition.finished
      .catch(() => {})
      .finally(() => {
        endSwitching();
        animatingRef.current = false;
      });
  }, []);

  const toggleTheme = useCallback(() => {
    changeTheme(themeRef.current === 'light' ? 'dark' : 'light');
  }, [changeTheme]);

  const setTheme = useCallback((nextTheme: Theme) => {
    changeTheme(nextTheme);
  }, [changeTheme]);

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
