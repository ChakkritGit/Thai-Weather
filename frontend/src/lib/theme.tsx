'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'light', toggle: () => {} });

/**
 * The server renders `data-theme` from the cookie when the user chose a theme;
 * otherwise CSS follows `prefers-color-scheme` and we detect it after mount.
 */
export function ThemeProvider({ initial, children }: { initial: Theme | null; children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial ?? 'light');
  useEffect(() => {
    if (!initial && window.matchMedia?.('(prefers-color-scheme: dark)').matches) setTheme('dark');
  }, [initial]);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      document.cookie = `thwx.theme=${next}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);
  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
