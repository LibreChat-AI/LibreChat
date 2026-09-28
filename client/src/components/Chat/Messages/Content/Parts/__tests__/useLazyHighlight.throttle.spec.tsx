import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import useLazyHighlight, {
  CodeHighlightThrottleContext,
  HIGHLIGHT_THROTTLE_MS,
} from '../useLazyHighlight';

const mockHighlight = jest.fn((_lang: string, code: string) => ({
  type: 'root',
  children: [{ type: 'text', value: code }],
}));

jest.mock('lowlight', () => ({
  __esModule: true,
  lowlight: {
    registered: () => true,
    highlight: (lang: string, code: string) => mockHighlight(lang, code),
    highlightAuto: (code: string) => mockHighlight('auto', code),
  },
}));

const flush = () => act(async () => Promise.resolve());

describe('useLazyHighlight throttling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockHighlight.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('ignores an in-flight highlight when the input changes', async () => {
    const { result, rerender } = renderHook(
      ({ code, lang }: { code: string; lang: string }) => useLazyHighlight(code, lang),
      { initialProps: { code: 'a', lang: 'js' } },
    );
    rerender({ code: 'b', lang: 'js' });

    await flush();
    expect(result.current).toEqual(['b']);

    act(() => jest.advanceTimersByTime(HIGHLIGHT_THROTTLE_MS));
    await flush();
    expect(result.current).toEqual(['b']);
  });

  it('highlights the first value immediately', async () => {
    const { result } = renderHook(() => useLazyHighlight('a', 'js'));
    expect([null, ['a']]).toContainEqual(result.current);
    await flush();
    expect(mockHighlight).toHaveBeenCalledTimes(1);
    expect(mockHighlight).toHaveBeenCalledWith('js', 'a');
    expect(result.current).toEqual(['a']);
  });

  it('throttles re-highlights while streaming and highlights the settled value once', async () => {
    const { result, rerender } = renderHook(({ code }) => useLazyHighlight(code, 'js'), {
      initialProps: { code: 'a' },
    });
    await flush();
    mockHighlight.mockClear();

    const chunks = ['ab', 'abc', 'abcd', 'abcde'];
    for (const code of chunks) {
      rerender({ code });
      act(() => jest.advanceTimersByTime(20));
    }
    expect(mockHighlight).not.toHaveBeenCalled();
    expect(result.current).toEqual(['abcde']);

    act(() => jest.advanceTimersByTime(HIGHLIGHT_THROTTLE_MS));
    await flush();
    expect(mockHighlight).toHaveBeenCalledTimes(1);
    expect(mockHighlight).toHaveBeenLastCalledWith('js', 'abcde');
    expect(result.current).toEqual(['abcde']);
  });

  it('keeps completed highlights when the configured throttle changes', async () => {
    let throttleMs = HIGHLIGHT_THROTTLE_MS;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CodeHighlightThrottleContext.Provider value={throttleMs}>
        {children}
      </CodeHighlightThrottleContext.Provider>
    );
    const { result, rerender } = renderHook(
      ({ code }: { code: string }) => useLazyHighlight(code, 'js'),
      {
        initialProps: { code: 'a' },
        wrapper,
      },
    );
    await flush();
    expect(result.current).toEqual(['a']);

    throttleMs += 100;
    rerender({ code: 'a' });

    expect(result.current).toEqual(['a']);
  });
  it('reschedules pending highlights when the configured throttle changes', async () => {
    let throttleMs = HIGHLIGHT_THROTTLE_MS;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CodeHighlightThrottleContext.Provider value={throttleMs}>
        {children}
      </CodeHighlightThrottleContext.Provider>
    );
    const { result, rerender } = renderHook(
      ({ code }: { code: string }) => useLazyHighlight(code, 'js'),
      {
        initialProps: { code: 'a' },
        wrapper,
      },
    );
    await flush();
    mockHighlight.mockClear();

    rerender({ code: 'ab' });
    act(() => jest.advanceTimersByTime(100));
    throttleMs = HIGHLIGHT_THROTTLE_MS * 2;
    rerender({ code: 'ab' });

    act(() => jest.advanceTimersByTime(HIGHLIGHT_THROTTLE_MS * 2 - 101));
    await flush();
    expect(mockHighlight).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(1));
    await flush();
    expect(mockHighlight).toHaveBeenCalledWith('js', 'ab');
    expect(result.current).toEqual(['ab']);
  });

  it('uses the configured throttle interval', async () => {
    const { result, rerender } = renderHook(({ code }) => useLazyHighlight(code, 'js'), {
      initialProps: { code: 'a' },
      wrapper: ({ children }) => (
        <CodeHighlightThrottleContext.Provider value={300}>
          {children}
        </CodeHighlightThrottleContext.Provider>
      ),
    });
    await flush();
    mockHighlight.mockClear();

    rerender({ code: 'ab' });
    act(() => jest.advanceTimersByTime(299));
    expect(result.current).toEqual(['ab']);
    act(() => jest.advanceTimersByTime(1));
    await flush();
    expect(result.current).toEqual(['ab']);
  });
  it('keeps the throttle window stable when the wall clock moves backwards', async () => {
    const { result, rerender } = renderHook(({ code }) => useLazyHighlight(code, 'js'), {
      initialProps: { code: 'a' },
    });
    await flush();
    mockHighlight.mockClear();

    rerender({ code: 'ab' });
    act(() => jest.setSystemTime(new Date(Date.now() - 60_000)));
    act(() => jest.advanceTimersByTime(HIGHLIGHT_THROTTLE_MS - 1));
    expect(result.current).toEqual(['ab']);
    act(() => jest.advanceTimersByTime(1));
    await flush();
    expect(result.current).toEqual(['ab']);
  });
  it('does not parse an initialized value twice on mount', async () => {
    const { result } = renderHook(() => useLazyHighlight('initialized', 'js'));
    await flush();
    expect(result.current).toEqual(['initialized']);
    expect(mockHighlight).toHaveBeenCalledTimes(1);
  });

  it('shows current raw code while a replacement highlight is pending', async () => {
    const { result, rerender } = renderHook(({ code }) => useLazyHighlight(code, 'js'), {
      initialProps: { code: 'echo a' },
    });
    await flush();
    rerender({ code: 'echo ab' });
    expect(result.current).toEqual(['echo ab']);
  });

  it('clears immediately when code becomes empty', async () => {
    const { result, rerender } = renderHook(
      ({ code }: { code: string | undefined }) => useLazyHighlight(code, 'js'),
      { initialProps: { code: 'a' as string | undefined } },
    );
    await flush();
    rerender({ code: 'ab' });
    rerender({ code: undefined });
    expect(result.current).toBeNull();
    act(() => jest.advanceTimersByTime(HIGHLIGHT_THROTTLE_MS * 2));
    await flush();
    expect(result.current).toBeNull();
  });

  it('does not schedule work after unmount', async () => {
    const { rerender, unmount } = renderHook(({ code }) => useLazyHighlight(code, 'js'), {
      initialProps: { code: 'a' },
    });
    await flush();
    mockHighlight.mockClear();
    rerender({ code: 'ab' });
    unmount();
    act(() => jest.advanceTimersByTime(HIGHLIGHT_THROTTLE_MS * 2));
    await flush();
    expect(mockHighlight).not.toHaveBeenCalled();
  });
});
