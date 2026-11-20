import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import useLazyHighlight, { CodeHighlightThrottleContext } from '../useLazyHighlight';

const mockHighlight = jest.fn();
jest.mock('lowlight', () => {
  const actual = jest.requireActual('lowlight');
  return {
    ...actual,
    lowlight: {
      ...actual.lowlight,
      highlight: (lang: string, code: string) => {
        mockHighlight(lang, code);
        return actual.lowlight.highlight(lang, code);
      },
    },
  };
});

/** Separate module scope keeps the grammar cache cold independently of other suites. */
it('finishes the initial lazy highlight when config resolves, without re-highlighting settled code', async () => {
  jest.useFakeTimers();
  try {
    let throttleMs = 300;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CodeHighlightThrottleContext.Provider value={throttleMs}>
        {children}
      </CodeHighlightThrottleContext.Provider>
    );
    const { result, rerender } = renderHook(({ code }) => useLazyHighlight(code, 'javascript'), {
      initialProps: { code: 'const first = 1;' },
      wrapper,
    });
    expect(mockHighlight).not.toHaveBeenCalled();
    throttleMs = 60000;
    rerender({ code: 'const first = 1;' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockHighlight).toHaveBeenCalledTimes(1);
    expect(mockHighlight).toHaveBeenLastCalledWith('javascript', 'const first = 1;');
    const initialTokens = result.current;
    expect(initialTokens).not.toEqual(['const first = 1;']);
    expect(jest.getTimerCount()).toBe(0);

    // A cadence-only change must not tokenize an already completed value again.
    throttleMs = 0;
    rerender({ code: 'const first = 1;' });
    expect(result.current).toBe(initialTokens);
    expect(mockHighlight).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(60000));
    expect(mockHighlight).toHaveBeenCalledTimes(1);

    rerender({ code: 'const second = 2;' });
    expect(mockHighlight).toHaveBeenCalledTimes(2);
    expect(mockHighlight).toHaveBeenLastCalledWith('javascript', 'const second = 2;');
  } finally {
    jest.useRealTimers();
  }
});
