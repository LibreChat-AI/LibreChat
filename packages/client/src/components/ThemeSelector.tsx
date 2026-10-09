import { useContext, useCallback, useEffect, useState } from 'react';
import { JSX } from 'react/jsx-runtime';
import { Sun, Moon, Monitor, Contrast } from 'lucide';
import type { IconNode } from './MorphIcon';
import { ThemeContext, isDark, isHighContrast } from '../theme';
import { MorphIcon } from './MorphIcon';
import { useLocalize } from '../hooks';
import { Button } from './Button';

declare global {
  interface Window {
    /** Last accepted change per appearance control. Global rather than a ref so
     *  the throttle survives the selector remounting, which the auth routes do
     *  on every navigation between login, register and verification. */
    lastThemeChange?: Record<string, number>;
  }
}

/** Ctrl+Shift+T auto-repeats while held, which is what this throttle is for.
 *  Keyed per control, because the scheme and contrast toggles are independent
 *  settings: going from plain light to high-contrast dark is one flip of each,
 *  and a shared window would silently swallow the second click. */
const CHANGE_THROTTLE_MS = 500;

type ThemeType = 'system' | 'dark' | 'light' | 'high-contrast-light' | 'high-contrast-dark';

/** Each control shows what it controls: the scheme toggle shows the scheme it
 *  is currently on, and the contrast toggle below owns the `Contrast` glyph. */
const themeIcons: Record<ThemeType, IconNode> = {
  system: Monitor,
  dark: Moon,
  light: Sun,
  'high-contrast-light': Sun,
  'high-contrast-dark': Moon,
};

const Theme = ({
  theme,
  highContrast,
  onChange,
}: {
  theme: string;
  highContrast: boolean;
  onChange: (value: string) => void;
}) => {
  const localize = useLocalize();

  const nextScheme = isDark(theme) ? 'light' : 'dark';
  /** The toggle flips the colour scheme without discarding a contrast choice.
   *  Resolved contrast rather than `isHighContrast(theme)`: under `system` the
   *  contrast comes from `prefers-contrast`, which the stored mode never names,
   *  so keying off the mode alone would silently drop an OS-requested need. */
  const nextTheme = highContrast ? `high-contrast-${nextScheme}` : nextScheme;

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        onChange(nextTheme);
      }
    };
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [nextTheme, onChange]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-auto w-auto p-2 text-text-primary"
      aria-label={localize('com_ui_toggle_theme')}
      aria-keyshortcuts="Ctrl+Shift+T"
      onClick={(e) => {
        e.preventDefault();
        onChange(nextTheme);
      }}
    >
      <MorphIcon icon={themeIcons[theme as ThemeType]} size={24} />
    </Button>
  );
};

/**
 * Contrast toggle, rendered beside the scheme toggle. On the login,
 * registration and email-verification routes this selector is the only
 * appearance control, and the scheme toggle above preserves a contrast choice
 * but can never introduce one — the full appearance dropdown lives behind auth.
 * Without this button a logged-out user who needs the high contrast palette
 * could reach it only by editing local storage or turning on an OS-wide
 * preference.
 */
const ContrastToggle = ({
  theme,
  highContrast,
  onChange,
}: {
  theme: string;
  highContrast: boolean;
  onChange: (value: string) => void;
}) => {
  const localize = useLocalize();

  const scheme = isDark(theme) ? 'dark' : 'light';
  /** Turning contrast off lands on the plain mode for the scheme currently
   *  rendered, so `system` under an OS contrast request becomes an explicit
   *  opt-out rather than silently snapping back on. */
  const nextTheme = highContrast ? scheme : `high-contrast-${scheme}`;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-auto w-auto p-2 text-text-primary"
      aria-label={localize('com_ui_toggle_high_contrast')}
      aria-pressed={highContrast}
      onClick={(e) => {
        e.preventDefault();
        onChange(nextTheme);
      }}
    >
      <MorphIcon icon={Contrast} size={24} />
    </Button>
  );
};

const ThemeSelector = ({ returnThemeOnly }: { returnThemeOnly?: boolean }): JSX.Element => {
  const { theme, highContrast, setTheme } = useContext(ThemeContext);
  const [announcement, setAnnouncement] = useState('');
  const localize = useLocalize();

  const changeTheme = useCallback(
    (value: string, control: string) => {
      const now = Date.now();
      const changes = window.lastThemeChange ?? {};
      const last = changes[control];
      if (typeof last === 'number' && now - last < CHANGE_THROTTLE_MS) {
        return;
      }
      window.lastThemeChange = { ...changes, [control]: now };

      setTheme(value);
      if (isHighContrast(value)) {
        setAnnouncement(
          isDark(value)
            ? localize('com_ui_high_contrast_dark_theme_enabled')
            : localize('com_ui_high_contrast_light_theme_enabled'),
        );
        return;
      }
      setAnnouncement(
        isDark(value)
          ? localize('com_ui_dark_theme_enabled')
          : localize('com_ui_light_theme_enabled'),
      );
    },
    [setTheme, localize],
  );

  const changeScheme = useCallback((value: string) => changeTheme(value, 'scheme'), [changeTheme]);
  const changeContrast = useCallback(
    (value: string) => changeTheme(value, 'contrast'),
    [changeTheme],
  );

  useEffect(() => {
    if (announcement) {
      const timeout = setTimeout(() => setAnnouncement(''), 1000);
      return () => clearTimeout(timeout);
    }
  }, [announcement]);

  if (returnThemeOnly === true) {
    return <Theme theme={theme} highContrast={highContrast} onChange={changeScheme} />;
  }

  return (
    <div className="flex flex-col items-center justify-center bg-surface-primary pt-6 sm:pt-0">
      <div className="absolute bottom-0 left-0 m-4 flex items-center">
        <Theme theme={theme} highContrast={highContrast} onChange={changeScheme} />
        <ContrastToggle theme={theme} highContrast={highContrast} onChange={changeContrast} />
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </div>
  );
};

export default ThemeSelector;
