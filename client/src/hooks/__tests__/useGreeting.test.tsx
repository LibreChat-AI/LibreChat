import { act, renderHook } from '@testing-library/react';
import type { TranslationKeys } from '../useLocalize';
import useGreeting from '../useGreeting';

jest.mock('../useLocalize', () => {
  const mockTranslations: Record<string, string> = jest.requireActual(
    '~/locales/en/translation.json',
  );
  return {
    __esModule: true,
    default: () => (key: TranslationKeys, options?: { name?: string }) =>
      mockTranslations[key].replace(/{{name}}/g, options?.name ?? ''),
  };
});

/** 2024-01-09 is a Tuesday, which uses the default schedule. */
const tuesdayAt = (hours: number, minutes = 0) => new Date(2024, 0, 9, hours, minutes, 0, 0);

describe('useGreeting', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves a localized greeting naming the user after mount', () => {
    jest.setSystemTime(tuesdayAt(9));
    const { result } = renderHook(() => useGreeting('Test User'));
    expect(result.current).toContain('Test User');
  });

  it('omits the name when the user has none', () => {
    jest.setSystemTime(tuesdayAt(9));
    const { result } = renderHook(() => useGreeting());
    expect(result.current).not.toBe('');
    expect(result.current).not.toContain('undefined');
    expect(result.current).not.toMatch(/,\s*$/);
  });

  it('replaces the fallback once the mount effect resolves local time', () => {
    jest.setSystemTime(tuesdayAt(9));
    const { result } = renderHook(() => useGreeting('Test User', 'fallback'));
    expect(result.current).not.toBe('fallback');
  });

  it('updates automatically across every slot of the day', () => {
    jest.setSystemTime(tuesdayAt(0, 0));
    const { result } = renderHook(() => useGreeting('Test User'));

    const seen = [result.current];
    for (let hour = 1; hour < 24; hour++) {
      act(() => {
        jest.advanceTimersByTime(60 * 60 * 1000);
      });
      seen.push(result.current);
    }

    seen.forEach((greeting) => expect(greeting).toContain('Test User'));
    /** Six slots a day: late night, dawn, morning, afternoon, evening, late night. */
    expect(new Set(seen).size).toBeGreaterThanOrEqual(4);
  });

  it('recalculates when the tab becomes visible again after a clock jump', () => {
    jest.setSystemTime(tuesdayAt(11, 0));
    const { result } = renderHook(() => useGreeting('Test User'));
    const morning = result.current;

    /** Simulates a sleep/timezone shift: wall clock moved without the timer firing. */
    jest.setSystemTime(tuesdayAt(18, 0));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current).not.toBe(morning);
    expect(result.current).toContain('Test User');
    expect(jest.getTimerCount()).toBe(1);
  });

  it('ignores visibility changes while the tab is hidden', () => {
    jest.setSystemTime(tuesdayAt(11, 0));
    const { result } = renderHook(() => useGreeting('Test User'));
    const morning = result.current;

    const visibilityState = jest
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    jest.setSystemTime(tuesdayAt(18, 0));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current).toBe(morning);
    visibilityState.mockRestore();
  });

  it('clears its timer and listeners on unmount', () => {
    jest.setSystemTime(tuesdayAt(11, 59));
    const removeDocumentListener = jest.spyOn(document, 'removeEventListener');
    const removeWindowListener = jest.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() => useGreeting('Test User'));
    expect(jest.getTimerCount()).toBe(1);

    unmount();
    expect(jest.getTimerCount()).toBe(0);
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function));

    removeDocumentListener.mockRestore();
    removeWindowListener.mockRestore();
  });
});
