import React from 'react';
import mermaid from 'mermaid';
import { SWRConfig } from 'swr';
import { ThemeContext } from '@librechat/client';
import { renderHook, waitFor } from '@testing-library/react';
import useMermaid from '../useMermaid';

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    parse: jest.fn(),
    initialize: jest.fn(),
    render: jest.fn(),
  },
}));

const mermaidMock = mermaid as unknown as {
  parse: jest.Mock;
  initialize: jest.Mock;
  render: jest.Mock;
};

const CONTENT = 'graph TD;\nA-->B;';

type Appearance = { resolvedMode: 'light' | 'dark'; highContrast: boolean };

let appearance: Appearance = { resolvedMode: 'light', highContrast: false };

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    <ThemeContext.Provider
      value={
        {
          theme: 'system',
          setTheme: () => undefined,
          resolvedMode: appearance.resolvedMode,
          highContrast: appearance.highContrast,
          setThemeRGB: () => undefined,
          setThemeDefinition: () => undefined,
          setThemeName: () => undefined,
          resetTheme: () => undefined,
        } as React.ContextType<typeof ThemeContext>
      }
    >
      {children}
    </ThemeContext.Provider>
  </SWRConfig>
);

describe('useMermaid cache key', () => {
  beforeEach(() => {
    appearance = { resolvedMode: 'light', highContrast: false };
    mermaidMock.parse.mockResolvedValue(true);
    mermaidMock.initialize.mockImplementation(() => undefined);
    mermaidMock.render.mockResolvedValue({ svg: '<svg id="d"><g></g></svg>' });
  });

  /** The cache key used to short-circuit to `customTheme` alone, so switching
   *  into a contrast mode replayed the SVG rendered with the old palette even
   *  though `mermaidConfig` had already rebuilt its theme variables. */
  it('rerenders a custom-themed diagram when contrast changes', async () => {
    const { rerender } = renderHook(() => useMermaid({ content: CONTENT, theme: 'forest' }), {
      wrapper,
    });

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));

    appearance = { resolvedMode: 'light', highContrast: true };
    rerender();

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));

    const [first, second] = mermaidMock.initialize.mock.calls;
    expect(first[0].theme).toBe('forest');
    expect(first[0].themeVariables).toBeUndefined();
    /** `base` is the only built-in theme mermaid applies `themeVariables` to, so
     *  the contrast palette has to outrank the caller's theme. */
    expect(second[0].theme).toBe('base');
    expect(second[0].themeVariables).toEqual(expect.objectContaining({ primaryColor: '#ffffff' }));
  });

  it('keeps the contrast palette ahead of a caller-supplied config theme', async () => {
    appearance = { resolvedMode: 'dark', highContrast: true };
    renderHook(
      () => useMermaid({ content: CONTENT, theme: 'forest', config: { theme: 'forest' } }),
      { wrapper },
    );

    await waitFor(() => expect(mermaidMock.initialize).toHaveBeenCalledTimes(1));

    const [config] = mermaidMock.initialize.mock.calls[0];
    expect(config.theme).toBe('base');
    expect(config.themeVariables).toEqual(expect.objectContaining({ primaryColor: '#000000' }));
  });

  it('rerenders a custom-themed diagram when the scheme changes', async () => {
    const { rerender } = renderHook(() => useMermaid({ content: CONTENT, theme: 'forest' }), {
      wrapper,
    });

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));

    appearance = { resolvedMode: 'dark', highContrast: false };
    rerender();

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));
  });

  it('reuses the cached SVG while the appearance holds still', async () => {
    const { rerender } = renderHook(() => useMermaid({ content: CONTENT, theme: 'forest' }), {
      wrapper,
    });

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));

    rerender();
    rerender();

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));
  });
});
