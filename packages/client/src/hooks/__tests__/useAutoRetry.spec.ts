import { act, renderHook } from '@testing-library/react';
import useAutoRetry from '../useAutoRetry';

const DELAYS = [2000, 5000] as const;

describe('useAutoRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('walks the backoff while the failure persists', () => {
    const onRetry = jest.fn();
    const { result } = renderHook(() =>
      useAutoRetry({ enabled: true, isRetrying: false, onRetry, delaysMs: DELAYS }),
    );

    expect(result.current.countdown).toBe(2);
    act(() => jest.advanceTimersByTime(2000));
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(5000));
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(result.current.isExhausted).toBe(true);
    expect(result.current.countdown).toBeNull();
  });

  it('cancels the pending attempt when a manual retry restarts the backoff', () => {
    const onRetry = jest.fn();
    const { result } = renderHook(() =>
      useAutoRetry({ enabled: true, isRetrying: false, onRetry, delaysMs: DELAYS }),
    );

    act(() => jest.advanceTimersByTime(1000));
    act(() => result.current.retryManually());
    expect(onRetry).toHaveBeenCalledTimes(1);

    // The first step's original deadline: it must no longer be armed.
    act(() => jest.advanceTimersByTime(1100));
    expect(onRetry).toHaveBeenCalledTimes(1);

    // ...and the restarted first step still runs, from the retry onwards.
    act(() => jest.advanceTimersByTime(900));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('retries at once and restarts the backoff when connectivity returns', () => {
    const onRetry = jest.fn();
    renderHook(() => useAutoRetry({ enabled: true, isRetrying: false, onRetry, delaysMs: DELAYS }));

    act(() => jest.advanceTimersByTime(1500));
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);

    act(() => jest.advanceTimersByTime(1900));
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(200));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('recovers when the window regains focus with the backoff already spent', () => {
    const onRetry = jest.fn();
    const { result } = renderHook(() =>
      useAutoRetry({ enabled: true, isRetrying: false, onRetry, delaysMs: DELAYS }),
    );

    act(() => jest.advanceTimersByTime(2000));
    act(() => jest.advanceTimersByTime(5000));
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(result.current.isExhausted).toBe(true);

    // Another window took focus and gave it back; the tab stayed visible throughout,
    // so `visibilitychange` never fires and this is the only signal available.
    act(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(result.current.isExhausted).toBe(false);
  });

  it('retries once when a tab switch reports both visibility and focus', () => {
    const onRetry = jest.fn();
    const visibility = jest.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('visible');
    renderHook(() => useAutoRetry({ enabled: true, isRetrying: false, onRetry, delaysMs: DELAYS }));

    visibility.mockReturnValue('hidden');
    act(() => {
      window.dispatchEvent(new Event('blur'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(onRetry).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it('does not schedule anything for a failure a retry cannot fix', () => {
    const onRetry = jest.fn();
    const { result } = renderHook(() =>
      useAutoRetry({ enabled: false, isRetrying: false, onRetry, delaysMs: DELAYS }),
    );

    expect(result.current.countdown).toBeNull();
    act(() => jest.advanceTimersByTime(60000));
    expect(onRetry).not.toHaveBeenCalled();
  });
});
