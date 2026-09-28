import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  ThemeProvider,
  isDark,
  isHighContrast,
  resolvesToHighContrast,
  useTheme,
} from './ThemeProvider';
import { highContrastDarkTheme, highContrastLightTheme } from '../themes/highContrast';

const matchMedia = (matches: boolean): MediaQueryList =>
  ({
    matches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }) as MediaQueryList;

function Controls() {
  const {
    resetTheme,
    setTheme,
    setThemeDefinition,
    setThemeName,
    setThemeRGB,
    themeName,
    highContrast,
    resolvedMode,
  } = useTheme();
  return (
    <>
      <output>{themeName}</output>
      <output data-testid="high-contrast">{String(highContrast)}</output>
      <output data-testid="resolved-mode">{resolvedMode}</output>
      <button onClick={() => setTheme('dark')}>Dark</button>
      <button onClick={() => setTheme('light')}>Light</button>
      <button onClick={() => setTheme('high-contrast-light')}>HC light</button>
      <button onClick={() => setTheme('high-contrast-dark')}>HC dark</button>
      <button onClick={() => setThemeName('renamed')}>Rename</button>
      <button onClick={() => setThemeName(undefined)}>Clear name</button>
      <button onClick={() => setThemeRGB({ 'rgb-accent-primary': '4 5 6' })}>Set legacy</button>
      <button
        onClick={() => {
          setThemeRGB({ 'rgb-accent-primary': '7 8 9' });
          setThemeName('batched');
        }}
      >
        Batch legacy
      </button>
      <button
        onClick={() => {
          setThemeName('name-first');
          setThemeRGB({ 'rgb-accent-primary': '10 11 12' });
        }}
      >
        Batch name first
      </button>
      <button onClick={() => setThemeDefinition(undefined)}>Clear definition</button>
      <button onClick={resetTheme}>Reset</button>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  window.matchMedia = jest.fn(() => matchMedia(false));
});

describe('ThemeProvider', () => {
  it('preserves CSS fallbacks for colors omitted by legacy RGB props', async () => {
    document.documentElement.style.setProperty('--text-primary', '9 9 9');
    render(
      <ThemeProvider
        initialTheme="light"
        themeName="legacy"
        themeRGB={{ 'rgb-accent-primary': '1 2 3' }}
      >
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('legacy');
    });
    expect(screen.getByText('legacy')).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('1 2 3');
    expect(document.documentElement.style.getPropertyValue('--text-primary')).toBe('9 9 9');

    act(() => screen.getByRole('button', { name: 'Dark' }).click());

    await waitFor(() => {
      expect(document.documentElement).toHaveClass('dark');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('1 2 3');
    expect(document.documentElement.style.getPropertyValue('--text-primary')).toBe('9 9 9');
  });

  it('keeps theme definition identity authoritative over legacy naming', async () => {
    render(
      <ThemeProvider
        initialTheme="light"
        themeName="legacy-name"
        themeDefinition={{
          version: 1,
          name: 'definition-name',
          modes: { light: { colors: { 'rgb-accent-primary': '1 2 3' } } },
        }}
      >
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('definition-name');
    });
    expect(screen.getByText('definition-name')).toBeInTheDocument();
    expect(localStorage.getItem('theme-name')).toBe('definition-name');
    expect(localStorage.getItem('theme-source')).toBe('definition');
  });

  it('applies a controlled definition without replacing stored theme preferences', async () => {
    const storedDefinition = {
      version: 1 as const,
      name: 'stored',
      modes: { light: { colors: { 'rgb-accent-primary': '1 2 3' } } },
    };
    const storedColors = { 'rgb-accent-primary': '1 2 3' };
    localStorage.setItem('theme-definition', JSON.stringify(storedDefinition));
    localStorage.setItem('theme-colors', JSON.stringify(storedColors));
    localStorage.setItem('theme-name', 'stored');
    localStorage.setItem('theme-source', 'legacy');

    const { rerender, unmount } = render(
      <ThemeProvider
        initialTheme="light"
        persistThemeDefinition={false}
        themeDefinition={{
          version: 1,
          name: 'deployment',
          modes: { light: { colors: { 'rgb-accent-primary': '4 5 6' } } },
        }}
      >
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('deployment');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('4 5 6');
    expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toEqual(storedDefinition);
    expect(JSON.parse(localStorage.getItem('theme-colors') ?? '{}')).toEqual(storedColors);
    expect(localStorage.getItem('theme-name')).toBe('stored');
    expect(localStorage.getItem('theme-source')).toBe('legacy');

    rerender(
      <ThemeProvider
        initialTheme="light"
        persistThemeDefinition={false}
        themeDefinition={{
          version: 1,
          name: 'deployment-next',
          modes: { light: { colors: { 'rgb-accent-primary': '7 8 9' } } },
        }}
      >
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('deployment-next');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('7 8 9');
    expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toEqual(storedDefinition);

    unmount();
    render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('stored');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('1 2 3');
  });

  it('keeps valid legacy overrides when another token is malformed', async () => {
    render(
      <ThemeProvider
        initialTheme="light"
        themeRGB={{
          'rgb-accent-primary': '1 2 3',
          'rgb-text-primary': 'invalid',
        }}
      >
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('1 2 3');
    });
    expect(document.documentElement.style.getPropertyValue('--text-primary')).toBe('');
    expect(JSON.parse(localStorage.getItem('theme-colors') ?? '{}')).toEqual({
      'rgb-accent-primary': '1 2 3',
    });
    expect(localStorage.getItem('theme-source')).toBe('legacy');
  });

  it('resets only theme-owned properties', async () => {
    document.documentElement.style.setProperty('--text-primary', '9 9 9', 'important');
    document.documentElement.style.setProperty('--markdown-font-size', '18px');
    document.documentElement.dataset.theme = 'host';
    render(
      <ThemeProvider initialTheme="light" themeRGB={{ 'rgb-accent-primary': '1 2 3' }}>
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('1 2 3');
    });
    act(() => screen.getByRole('button', { name: 'Reset' }).click());

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('');
    });
    expect(document.documentElement.style.getPropertyValue('--text-primary')).toBe('9 9 9');
    expect(document.documentElement.dataset.theme).toBe('host');
    expect(document.documentElement.style.getPropertyValue('--markdown-font-size')).toBe('18px');
    expect(localStorage.getItem('theme-definition')).toBeNull();
    expect(localStorage.getItem('theme-name')).toBeNull();
    expect(localStorage.getItem('theme-source')).toBeNull();
  });

  it('does not remove host theme variables when no custom theme is active', async () => {
    document.documentElement.style.setProperty('--text-primary', '9 9 9');
    document.documentElement.dataset.theme = 'host';

    const { unmount } = render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement).toHaveClass('light');
    });
    expect(document.documentElement.style.getPropertyValue('--text-primary')).toBe('9 9 9');
    expect(document.documentElement.dataset.theme).toBe('host');

    unmount();

    expect(document.documentElement.style.getPropertyValue('--text-primary')).toBe('9 9 9');
    expect(document.documentElement.dataset.theme).toBe('host');
    expect(document.documentElement).not.toHaveClass('light');
  });

  it('restores host theme values and classes when the provider unmounts', async () => {
    document.documentElement.style.setProperty('--accent-primary', '9 9 9');
    document.documentElement.dataset.theme = 'host';
    document.documentElement.classList.add('dark');

    const { unmount } = render(
      <ThemeProvider
        initialTheme="light"
        themeDefinition={{
          version: 1,
          name: 'embedded',
          modes: { light: { colors: { 'rgb-accent-primary': '1 2 3' } } },
        }}
      >
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('embedded');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('1 2 3');
    expect(document.documentElement).toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');

    unmount();

    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('9 9 9');
    expect(document.documentElement.dataset.theme).toBe('host');
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement).not.toHaveClass('light');
  });

  it('persists legacy prop overrides for later mounts', async () => {
    const { unmount } = render(
      <ThemeProvider
        initialTheme="light"
        themeName="legacy"
        themeRGB={{ 'rgb-accent-primary': '1 2 3' }}
      >
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toMatchObject({
        name: 'legacy',
      });
    });
    expect(JSON.parse(localStorage.getItem('theme-colors') ?? '{}')).toEqual({
      'rgb-accent-primary': '1 2 3',
    });
    expect(localStorage.getItem('color-theme')).toBe('light');
    expect(localStorage.getItem('theme-source')).toBe('legacy');

    unmount();
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('legacy');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('1 2 3');
  });

  it('does not let stale legacy storage downgrade an authoritative definition', async () => {
    localStorage.setItem(
      'theme-definition',
      JSON.stringify({
        version: 1,
        name: 'native',
        modes: { light: { colors: { 'rgb-accent-primary': '1 2 3' } } },
      }),
    );
    localStorage.setItem('theme-colors', JSON.stringify({ 'rgb-accent-primary': '7 8 9' }));

    render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('native');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('1 2 3');
    expect(document.documentElement.style.getPropertyValue('--text-primary')).not.toBe('');
  });

  it('applies a name-only prop over a stored definition', async () => {
    localStorage.setItem(
      'theme-definition',
      JSON.stringify({
        version: 1,
        name: 'stored',
        modes: { light: { colors: { 'rgb-accent-primary': '1 2 3' } } },
      }),
    );

    render(
      <ThemeProvider initialTheme="light" themeName="brand">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('brand');
    });
    expect(screen.getByText('brand')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toMatchObject({
      name: 'brand',
    });
    expect(localStorage.getItem('theme-name')).toBe('brand');
    expect(localStorage.getItem('theme-source')).toBe('definition');
  });

  it('keeps a name-only prop over migrated storage partial after remount', async () => {
    document.documentElement.style.setProperty('--text-primary', '9 9 9');
    localStorage.setItem('theme-colors', JSON.stringify({ 'rgb-accent-primary': '1 2 3' }));

    const { unmount } = render(
      <ThemeProvider initialTheme="light" themeName="brand">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('brand');
    });
    expect(localStorage.getItem('theme-source')).toBe('legacy');

    unmount();
    render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('brand');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('1 2 3');
    expect(document.documentElement.style.getPropertyValue('--text-primary')).toBe('9 9 9');
  });

  it('preserves legacy provenance when a migrated stored theme is renamed', async () => {
    document.documentElement.style.setProperty('--text-primary', '9 9 9');
    localStorage.setItem('theme-colors', JSON.stringify({ 'rgb-accent-primary': '1 2 3' }));

    const { unmount } = render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'Rename' }).click());

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('renamed');
    });
    expect(localStorage.getItem('theme-source')).toBe('legacy');

    unmount();
    render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('renamed');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('1 2 3');
    expect(document.documentElement.style.getPropertyValue('--text-primary')).toBe('9 9 9');
  });

  it('keeps the active definition name synchronized across reloads', async () => {
    render(
      <ThemeProvider
        initialTheme="light"
        themeName="legacy"
        themeRGB={{ 'rgb-accent-primary': '1 2 3' }}
      >
        <Controls />
      </ThemeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'Rename' }).click());

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('renamed');
    });
    expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toMatchObject({
      name: 'renamed',
    });
    expect(localStorage.getItem('theme-name')).toBe('renamed');
  });

  it('synchronizes legacy theme props after mount and restores the host when removed', async () => {
    document.documentElement.style.setProperty('--accent-primary', '9 9 9');
    const firstColors = { 'rgb-accent-primary': '1 2 3' };
    const secondColors = { 'rgb-accent-primary': '4 5 6' };
    const { rerender } = render(
      <ThemeProvider initialTheme="light" themeName="first" themeRGB={firstColors}>
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('first');
    });
    rerender(
      <ThemeProvider initialTheme="dark" themeName="second" themeRGB={secondColors}>
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('second');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('4 5 6');
    expect(document.documentElement).toHaveClass('dark');
    expect(JSON.parse(localStorage.getItem('theme-colors') ?? '{}')).toEqual(secondColors);

    rerender(
      <ThemeProvider initialTheme="dark">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('9 9 9');
    });
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(localStorage.getItem('theme-definition')).toBeNull();
  });

  it('retains a controlled theme name when only controlled colors are removed', async () => {
    const colors = { 'rgb-accent-primary': '1 2 3' };
    const { rerender } = render(
      <ThemeProvider initialTheme="light" themeName="brand" themeRGB={colors}>
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('brand');
    });
    rerender(
      <ThemeProvider initialTheme="light" themeName="brand">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('brand')).toBeInTheDocument();
    });
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(localStorage.getItem('theme-definition')).toBeNull();
    expect(localStorage.getItem('theme-name')).toBe('brand');
  });

  it('reapplies an unchanged legacy name when switching away from a definition', async () => {
    const definition = {
      version: 1 as const,
      name: 'native',
      modes: { light: { colors: { 'rgb-accent-primary': '1 2 3' } } },
    };
    const legacyColors = { 'rgb-accent-primary': '4 5 6' };
    const { rerender } = render(
      <ThemeProvider initialTheme="light" themeName="brand" themeDefinition={definition}>
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('native');
    });
    rerender(
      <ThemeProvider initialTheme="light" themeName="brand" themeRGB={legacyColors}>
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('brand');
    });
    expect(screen.getByText('brand')).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('4 5 6');
    expect(localStorage.getItem('theme-name')).toBe('brand');
    expect(localStorage.getItem('theme-source')).toBe('legacy');
  });

  it('synchronizes valid definition props while ignoring invalid replacements', async () => {
    const { rerender } = render(
      <ThemeProvider
        initialTheme="light"
        themeDefinition={{
          version: 1,
          name: 'first',
          modes: { light: { colors: { 'rgb-accent-primary': '1 2 3' } } },
        }}
      >
        <Controls />
      </ThemeProvider>,
    );

    rerender(
      <ThemeProvider
        initialTheme="light"
        themeDefinition={{
          version: 1,
          name: 'second',
          modes: { light: { colors: { 'rgb-accent-primary': '4 5 6' } } },
        }}
      >
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('second');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('4 5 6');

    rerender(
      <ThemeProvider
        initialTheme="light"
        themeDefinition={{ version: 1, name: 'invalid', modes: { light: [] as never } }}
      >
        <Controls />
      </ThemeProvider>,
    );

    expect(document.documentElement.dataset.theme).toBe('second');
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('4 5 6');
    expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toMatchObject({
      name: 'second',
    });
  });

  it('coordinates batched legacy color and name updates', async () => {
    render(
      <ThemeProvider
        initialTheme="light"
        themeName="legacy"
        themeRGB={{ 'rgb-accent-primary': '1 2 3' }}
      >
        <Controls />
      </ThemeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'Batch legacy' }).click());

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('batched');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('7 8 9');
    expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toMatchObject({
      name: 'batched',
      modes: {
        light: { colors: { 'rgb-accent-primary': '7 8 9' } },
      },
    });
    expect(JSON.parse(localStorage.getItem('theme-colors') ?? '{}')).toEqual({
      'rgb-accent-primary': '7 8 9',
    });
  });

  it('coordinates batched legacy name and color updates when no definition is active', async () => {
    render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'Batch name first' }).click());

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('name-first');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('10 11 12');
    expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toMatchObject({
      name: 'name-first',
      modes: {
        light: { colors: { 'rgb-accent-primary': '10 11 12' } },
      },
    });
  });

  it('keeps a valid stored theme when an invalid prop definition is added or removed', async () => {
    const storedDefinition = {
      version: 1 as const,
      name: 'stored',
      modes: { light: { colors: { 'rgb-accent-primary': '9 8 7' } } },
    };
    localStorage.setItem('theme-definition', JSON.stringify(storedDefinition));
    localStorage.setItem('theme-name', 'stored');

    const { rerender } = render(
      <ThemeProvider
        initialTheme="light"
        themeDefinition={{
          version: 1,
          name: 'invalid',
          modes: { light: { colors: { 'rgb-accent-primary': 'not-rgb' } } },
        }}
      >
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('stored');
    });
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('9 8 7');
    expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toEqual(storedDefinition);
    expect(localStorage.getItem('theme-name')).toBe('stored');

    rerender(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    expect(document.documentElement.dataset.theme).toBe('stored');
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('9 8 7');
    expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toEqual(storedDefinition);
  });

  it('uses a stable identity when a legacy consumer clears an active theme name', async () => {
    render(
      <ThemeProvider
        initialTheme="light"
        themeName="legacy"
        themeRGB={{ 'rgb-accent-primary': '1 2 3' }}
      >
        <Controls />
      </ThemeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'Clear name' }).click());

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('custom');
    });
    expect(screen.getByText('custom')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toMatchObject({
      name: 'custom',
    });
    expect(localStorage.getItem('theme-name')).toBe('custom');
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('1 2 3');
  });

  it('removes legacy colors when the authoritative definition is cleared', async () => {
    render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'Set legacy' }).click());
    await waitFor(() => {
      expect(localStorage.getItem('theme-colors')).not.toBeNull();
    });

    act(() => screen.getByRole('button', { name: 'Clear definition' }).click());

    expect(localStorage.getItem('theme-definition')).toBeNull();
    expect(localStorage.getItem('theme-colors')).toBeNull();
    expect(localStorage.getItem('theme-source')).toBeNull();
  });

  it('applies the high contrast light palette and marks the root element', async () => {
    render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'HC light' }).click());

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('high-contrast');
    });
    const root = document.documentElement;
    expect(root).toHaveClass('high-contrast', 'light');
    expect(root).not.toHaveClass('dark');
    expect(root.style.getPropertyValue('--surface-primary')).toBe(
      highContrastLightTheme['rgb-surface-primary'],
    );
    expect(root.style.getPropertyValue('--text-primary')).toBe(
      highContrastLightTheme['rgb-text-primary'],
    );
    expect(root.style.getPropertyValue('color-scheme')).toBe('light');
    expect(localStorage.getItem('color-theme')).toBe('high-contrast-light');
  });

  it('treats high contrast dark as a dark colour scheme', async () => {
    render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'HC dark' }).click());

    await waitFor(() => {
      expect(document.documentElement).toHaveClass('dark');
    });
    const root = document.documentElement;
    expect(root).toHaveClass('high-contrast');
    expect(root).not.toHaveClass('light');
    expect(root.style.getPropertyValue('--surface-primary')).toBe(
      highContrastDarkTheme['rgb-surface-primary'],
    );
    expect(root.style.getPropertyValue('color-scheme')).toBe('dark');
    expect(isDark('high-contrast-dark')).toBe(true);
    expect(isDark('high-contrast-light')).toBe(false);
    expect(isHighContrast('high-contrast-dark')).toBe(true);
    expect(isHighContrast('dark')).toBe(false);
  });

  it('restores the standard palette when leaving high contrast', async () => {
    const root = document.documentElement;
    root.style.setProperty('color-scheme', 'only light', 'important');
    render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    act(() => screen.getByRole('button', { name: 'HC dark' }).click());
    await waitFor(() => {
      expect(document.documentElement).toHaveClass('high-contrast');
    });
    expect(root.style.getPropertyValue('color-scheme')).toBe('dark');
    expect(root.style.getPropertyPriority('color-scheme')).toBe('');

    act(() => screen.getByRole('button', { name: 'Light' }).click());

    await waitFor(() => {
      expect(document.documentElement).not.toHaveClass('high-contrast');
    });
    expect(root.style.getPropertyValue('--surface-primary')).toBe('');
    expect(root.style.getPropertyValue('--text-primary')).toBe('');
    expect(root.style.getPropertyValue('color-scheme')).toBe('only light');
    expect(root.style.getPropertyPriority('color-scheme')).toBe('important');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('outranks a deployment custom theme, because contrast is an accessibility need', async () => {
    render(
      <ThemeProvider
        initialTheme="light"
        themeName="brand"
        themeRGB={{ 'rgb-surface-primary': '1 2 3' }}
      >
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--surface-primary')).toBe('1 2 3');
    });

    act(() => screen.getByRole('button', { name: 'HC light' }).click());

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('high-contrast');
    });
    expect(document.documentElement.style.getPropertyValue('--surface-primary')).toBe(
      highContrastLightTheme['rgb-surface-primary'],
    );

    act(() => screen.getByRole('button', { name: 'Light' }).click());

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('brand');
    });
    expect(document.documentElement.style.getPropertyValue('--surface-primary')).toBe('1 2 3');
  });

  it('follows the OS contrast preference under the system mode', async () => {
    window.matchMedia = jest.fn((query: string) => matchMedia(query.includes('contrast')));
    render(
      <ThemeProvider initialTheme="system">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement).toHaveClass('high-contrast');
    });
    const root = document.documentElement;
    expect(root).toHaveClass('light');
    expect(root.style.getPropertyValue('--surface-primary')).toBe(
      highContrastLightTheme['rgb-surface-primary'],
    );
    expect(resolvesToHighContrast('system')).toBe(true);
    /** The stored mode stays `system`; contrast is resolved, not chosen. */
    expect(isHighContrast('system')).toBe(false);
    expect(localStorage.getItem('color-theme')).toBe('system');
  });

  it('leaves an explicit colour scheme alone when the OS asks for more contrast', async () => {
    window.matchMedia = jest.fn((query: string) => matchMedia(query.includes('contrast')));
    render(
      <ThemeProvider initialTheme="light">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement).toHaveClass('light');
    });
    expect(document.documentElement).not.toHaveClass('high-contrast');
    expect(resolvesToHighContrast('light')).toBe(false);
  });

  it('reacts when the OS contrast preference changes under the system mode', async () => {
    const listeners: Array<() => void> = [];
    let prefersContrast = false;
    window.matchMedia = jest.fn((query: string) => {
      const isContrastQuery = query.includes('contrast');
      return {
        ...matchMedia(isContrastQuery && prefersContrast),
        addEventListener: (_event: string, listener: () => void) => {
          if (isContrastQuery) {
            listeners.push(listener);
          }
        },
        removeEventListener: jest.fn(),
      } as unknown as MediaQueryList;
    });

    render(
      <ThemeProvider initialTheme="system">
        <Controls />
      </ThemeProvider>,
    );
    expect(document.documentElement).not.toHaveClass('high-contrast');
    expect(screen.getByTestId('high-contrast')).toHaveTextContent('false');

    prefersContrast = true;
    act(() => listeners.forEach((listener) => listener()));

    await waitFor(() => {
      expect(document.documentElement).toHaveClass('high-contrast');
    });
    expect(document.documentElement.dataset.theme).toBe('high-contrast');
    /** The DOM alone is not enough: a consumer keying off the resolved contrast,
     *  such as the Mermaid cache, only recomputes if the context value moves. */
    expect(screen.getByTestId('high-contrast')).toHaveTextContent('true');
  });

  /** Windows Contrast Themes reach the browser as `forced-colors: active` with
   *  `prefers-contrast: custom`; `more` never matches, so resolving contrast
   *  from `more` alone left the palette off on the platform the README names. */
  it('treats a forced-colors palette as an OS contrast request', async () => {
    window.matchMedia = jest.fn((query: string) => matchMedia(query === '(forced-colors: active)'));
    render(
      <ThemeProvider initialTheme="system">
        <Controls />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement).toHaveClass('high-contrast');
    });
    expect(screen.getByTestId('high-contrast')).toHaveTextContent('true');
    expect(resolvesToHighContrast('system')).toBe(true);
  });

  /** The same staleness for the scheme: with contrast already on, flipping the
   *  OS colour scheme leaves `theme` at `system` and `setHighContrast` a no-op,
   *  so nothing rerendered until the resolved mode was published too. */
  it('reacts when the OS colour scheme changes under the system mode', async () => {
    const listeners: Array<() => void> = [];
    let prefersDark = false;
    window.matchMedia = jest.fn((query: string) => {
      const isSchemeQuery = query.includes('color-scheme');
      return {
        ...matchMedia(isSchemeQuery ? prefersDark : true),
        addEventListener: (_event: string, listener: () => void) => {
          if (isSchemeQuery) {
            listeners.push(listener);
          }
        },
        removeEventListener: jest.fn(),
      } as unknown as MediaQueryList;
    });

    render(
      <ThemeProvider initialTheme="system">
        <Controls />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved-mode')).toHaveTextContent('light');
    expect(screen.getByTestId('high-contrast')).toHaveTextContent('true');

    prefersDark = true;
    act(() => listeners.forEach((listener) => listener()));

    await waitFor(() => {
      expect(screen.getByTestId('resolved-mode')).toHaveTextContent('dark');
    });
    expect(document.documentElement).toHaveClass('dark', 'high-contrast');
  });

  /** The provider reads both media queries during render now, so it has to
   *  tolerate the absence of a window the way the storage helpers already do. */
  it('renders without a window, as under server rendering', () => {
    const restore = window.matchMedia;
    /** jsdom's property is non-configurable, so assign rather than redefine. */
    window.matchMedia = undefined as unknown as typeof window.matchMedia;

    try {
      expect(() =>
        render(
          <ThemeProvider initialTheme="system">
            <Controls />
          </ThemeProvider>,
        ),
      ).not.toThrow();
      expect(screen.getByTestId('resolved-mode')).toHaveTextContent('light');
      expect(screen.getByTestId('high-contrast')).toHaveTextContent('false');
    } finally {
      window.matchMedia = restore;
    }
  });

  /** A media query read during render would make the server's markup and the
   *  first client render disagree, so the seed comes from the mode string only
   *  and the OS-resolved values arrive from the effect. */
  it('seeds the published values from the mode alone, not from a media query', () => {
    const matchMediaSpy = jest.fn(() => matchMedia(true));
    window.matchMedia = matchMediaSpy;

    /** An explicit mode needs no query to resolve, so it is published at once. */
    const explicit = render(
      <ThemeProvider initialTheme="high-contrast-dark">
        <Controls />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved-mode')).toHaveTextContent('dark');
    expect(screen.getByTestId('high-contrast')).toHaveTextContent('true');
    explicit.unmount();

    /** `system` cannot resolve without a query, so it seeds light with no
     *  contrast and the effect corrects it, which is what keeps hydration
     *  deterministic even though this environment reports dark and more. */
    render(
      <ThemeProvider initialTheme="system">
        <Controls />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved-mode')).toHaveTextContent('dark');
    expect(matchMediaSpy).toHaveBeenCalled();
  });
});
