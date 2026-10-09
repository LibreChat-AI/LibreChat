//ThemeContext.js
// source: https://plainenglish.io/blog/light-and-dark-mode-in-react-web-application-with-tailwind-css-89674496b942
import React, { createContext, useState, useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { JSX } from 'react/jsx-runtime';
import { getInitialTheme, applyFontSize } from '~/utils';
import { fontSizeAtom } from '~/store';

type ProviderValue = {
  theme: string;
  setTheme: React.Dispatch<React.SetStateAction<string>>;
};

const defaultContextValue: ProviderValue = {
  theme: getInitialTheme(),
  setTheme: () => {
    return;
  },
};

export const isDark = (theme: string): boolean => {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return theme === 'dark';
};

export const ThemeContext: React.Context<ProviderValue> =
  createContext<ProviderValue>(defaultContextValue);

export const ThemeProvider = ({
  initialTheme,
  children,
}: {
  initialTheme?: string;
  children: React.ReactNode;
}): JSX.Element => {
  const [theme, setTheme] = useState(getInitialTheme);
  const setFontSize = useSetAtom(fontSizeAtom);

  const rawSetTheme = (rawTheme: string) => {
    const root = window.document.documentElement;
    const darkMode = isDark(rawTheme);

    root.classList.remove(darkMode ? 'light' : 'dark');
    root.classList.add(darkMode ? 'dark' : 'light');

    localStorage.setItem('color-theme', rawTheme);
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const changeThemeOnSystemChange = () => {
      rawSetTheme(mediaQuery.matches ? 'dark' : 'light');
    };

    mediaQuery.addEventListener('change', changeThemeOnSystemChange);

    return () => {
      mediaQuery.removeEventListener('change', changeThemeOnSystemChange);
    };
  }, []);

  useEffect(() => {
    const fontSize = localStorage.getItem('fontSize');
    if (fontSize == null) {
      setFontSize('text-base');
      applyFontSize('text-base');
      localStorage.setItem('fontSize', JSON.stringify('text-base'));
      return;
    }
    try {
      applyFontSize(JSON.parse(fontSize));
    } catch (error) {
      console.log(error);
    }
    // Reason: This effect should only run once, and `setFontSize` is a stable function
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (initialTheme) {
    rawSetTheme(initialTheme);
  }

  useEffect(() => {
    rawSetTheme(theme);
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
};
