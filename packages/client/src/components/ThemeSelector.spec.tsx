import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ThemeSelector from './ThemeSelector';
import { ThemeContext } from '../theme';

jest.mock('./MorphIcon', () => {
  const { createMorphIconMock } = jest.requireActual('../test/mockMorphIcon');
  const { Sun, Moon, Monitor, Contrast } = jest.requireActual('lucide');
  return {
    MorphIcon: createMorphIconMock([
      [Sun, 'sun'],
      [Moon, 'moon'],
      [Monitor, 'monitor'],
      [Contrast, 'contrast'],
    ]),
  };
});

jest.mock('../hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const renderWith = (
  theme: string,
  highContrast: boolean,
  setTheme: jest.Mock,
  children: React.ReactElement,
) => {
  const view = render(
    <ThemeContext.Provider
      value={
        {
          theme,
          setTheme,
          resolvedMode: 'light',
          highContrast,
          setThemeRGB: () => undefined,
          setThemeDefinition: () => undefined,
          setThemeName: () => undefined,
          resetTheme: () => undefined,
        } as React.ContextType<typeof ThemeContext>
      }
    >
      {children}
    </ThemeContext.Provider>,
  );
  return { setTheme, unmount: view.unmount };
};

const renderTheme = (theme: string, highContrast = false, setTheme = jest.fn()) =>
  renderWith(theme, highContrast, setTheme, <ThemeSelector returnThemeOnly />);

/** The form the auth routes render: both appearance controls, no host chrome. */
const renderAuthControls = (theme: string, highContrast = false, setTheme = jest.fn()) =>
  renderWith(theme, highContrast, setTheme, <ThemeSelector />);

beforeEach(() => {
  /** `changeTheme` throttles itself through this global for 500ms. */
  window.lastThemeChange = undefined;
  window.matchMedia = jest.fn().mockImplementation(
    (media: string) =>
      ({
        matches: false,
        media,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }) as unknown as MediaQueryList,
  );
});

describe('ThemeSelector MorphIcon map', () => {
  it('shows monitor for system, moon for dark, sun for light', () => {
    const system = renderTheme('system');
    expect(screen.getByTestId('monitor')).toBeInTheDocument();
    expect(screen.getByTestId('monitor')).toHaveAttribute('data-size', '24');
    system.unmount();

    const dark = renderTheme('dark');
    expect(screen.getByTestId('moon')).toBeInTheDocument();
    dark.unmount();

    renderTheme('light');
    expect(screen.getByTestId('sun')).toBeInTheDocument();
  });

  /** An unmapped icon falls back to `morph-icon`, so a missing high contrast
   *  entry in the icon record would surface here rather than as a blank glyph.
   *  The contrast modes show their scheme, because the contrast toggle beside
   *  them owns the contrast glyph. */
  it('shows the scheme icon for both high contrast modes', () => {
    const light = renderTheme('high-contrast-light', true);
    expect(screen.getByTestId('sun')).toBeInTheDocument();
    light.unmount();

    renderTheme('high-contrast-dark', true);
    expect(screen.getByTestId('moon')).toBeInTheDocument();
  });

  it('toggles theme when the button is activated', () => {
    // isDark('light') is false → next is dark
    const { setTheme } = renderTheme('light');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_toggle_theme' }));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });
});

describe('ThemeSelector scheme toggle', () => {
  it('flips the scheme and keeps an explicit contrast choice', () => {
    const { setTheme } = renderTheme('high-contrast-light', true);
    fireEvent.click(screen.getByRole('button'));
    expect(setTheme).toHaveBeenCalledWith('high-contrast-dark');
  });

  /** Under `system` the contrast comes from `prefers-contrast`, so the stored
   *  mode never names it and only the resolved value can carry it forward. */
  it('keeps an OS-requested contrast when the stored mode is system', () => {
    const { setTheme } = renderTheme('system', true);
    fireEvent.click(screen.getByRole('button'));
    expect(setTheme).toHaveBeenCalledWith('high-contrast-dark');
  });

  it('leaves an ordinary system mode on the plain schemes', () => {
    const { setTheme } = renderTheme('system', false);
    fireEvent.click(screen.getByRole('button'));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('answers Ctrl+Shift+T with the same choice', () => {
    const { setTheme } = renderTheme('system', true);
    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true });
    expect(setTheme).toHaveBeenCalledWith('high-contrast-dark');
  });
});

/** The auth routes render this selector alone, so contrast has to be reachable
 *  from it — the scheme toggle preserves a contrast choice but never makes one. */
describe('ThemeSelector contrast toggle', () => {
  it('turns contrast on for the scheme currently rendered', () => {
    const { setTheme } = renderAuthControls('dark');
    const toggle = screen.getByRole('button', { name: 'com_ui_toggle_high_contrast' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(setTheme).toHaveBeenCalledWith('high-contrast-dark');
  });

  it('turns an explicit contrast mode back off', () => {
    const { setTheme } = renderAuthControls('high-contrast-light', true);
    const toggle = screen.getByRole('button', { name: 'com_ui_toggle_high_contrast' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  /** Under `system` the OS supplies the contrast, so opting out has to name an
   *  explicit mode rather than leave `system` to switch it straight back on. */
  it('opts out of an OS-requested contrast explicitly', () => {
    const { setTheme } = renderAuthControls('system', true);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_toggle_high_contrast' }));
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  /** The two controls are independent settings, so a single gesture that flips
   *  both — plain light to high-contrast dark — has to land twice. A throttle
   *  shared across the pair swallowed whichever click came second. */
  it('accepts both controls inside one throttle window', () => {
    const { setTheme } = renderAuthControls('light');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_toggle_theme' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_toggle_high_contrast' }));
    expect(setTheme).toHaveBeenNthCalledWith(1, 'dark');
    expect(setTheme).toHaveBeenNthCalledWith(2, 'high-contrast-light');
  });

  /** The throttle still does its job within a control: Ctrl+Shift+T auto-repeats
   *  while held, and a held key must not stream theme writes. */
  it('still throttles repeats of the same control', () => {
    const { setTheme } = renderAuthControls('light');
    const toggle = screen.getByRole('button', { name: 'com_ui_toggle_high_contrast' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(setTheme).toHaveBeenCalledTimes(1);
  });
});
