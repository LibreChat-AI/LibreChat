import { useQueryClient } from '@tanstack/react-query';
import { renderHook, act } from '@testing-library/react';
import { QueryKeys, Time } from 'librechat-data-provider';
import { useHealthCheck } from '../connection';

// Mock dependencies
jest.mock('@tanstack/react-query');
jest.mock('librechat-data-provider', () => ({
  QueryKeys: { health: 'health' },
  Time: { TEN_MINUTES: 600000, FIVE_MINUTES: 300000 },
  dataService: { healthCheck: jest.fn() },
}));

jest.mock('~/utils', () => ({
  logger: { log: jest.fn() },
}));

// Mock timers
jest.useFakeTimers();

const mockQueryClient = {
  fetchQuery: jest.fn(),
  getQueryState: jest.fn(),
  getQueryData: jest.fn(),
  invalidateQueries: jest.fn(),
} as any;

const mockUseQueryClient = useQueryClient as jest.MockedFunction<typeof useQueryClient>;

describe('useHealthCheck', () => {
  let addEventListenerSpy: jest.SpyInstance;
  let removeEventListenerSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    mockUseQueryClient.mockReturnValue(mockQueryClient);

    addEventListenerSpy = jest.spyOn(window, 'addEventListener');
    removeEventListenerSpy = jest.spyOn(window, 'removeEventListener');

    mockQueryClient.fetchQuery.mockResolvedValue({});
    mockQueryClient.getQueryState.mockReturnValue(null);
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  describe('when not authenticated', () => {
    it('should not start health check', () => {
      renderHook(() => useHealthCheck(false));

      // Fast-forward past the delay
      act(() => {
        jest.advanceTimersByTime(1000);
      });

      expect(mockQueryClient.fetchQuery).not.toHaveBeenCalled();
      expect(addEventListenerSpy).not.toHaveBeenCalled();
    });
  });

  describe('when authenticated', () => {
    it('should start health check after delay', async () => {
      renderHook(() => useHealthCheck(true));

      // Should not run immediately
      expect(mockQueryClient.fetchQuery).not.toHaveBeenCalled();

      // Should run after 500ms delay
      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      expect(mockQueryClient.fetchQuery).toHaveBeenCalledWith(
        [QueryKeys.health],
        expect.any(Function),
        {
          retry: false,
          cacheTime: 0,
          staleTime: 0,
        },
      );
    });

    it('should set up 10-minute interval', async () => {
      renderHook(() => useHealthCheck(true));

      await act(async () => {
        jest.advanceTimersByTime(500); // Initial delay
      });

      // Clear the initial call
      mockQueryClient.fetchQuery.mockClear();

      // Advance by 10 minutes
      await act(async () => {
        jest.advanceTimersByTime(Time.TEN_MINUTES);
      });

      expect(mockQueryClient.fetchQuery).toHaveBeenCalledTimes(1);
    });

    it('should run health check continuously every 10 minutes', async () => {
      renderHook(() => useHealthCheck(true));

      await act(async () => {
        jest.advanceTimersByTime(500); // Initial delay
      });

      // Clear the initial call
      mockQueryClient.fetchQuery.mockClear();

      // Test multiple intervals to ensure it keeps running
      for (let i = 1; i <= 5; i++) {
        await act(async () => {
          jest.advanceTimersByTime(Time.TEN_MINUTES);
        });

        expect(mockQueryClient.fetchQuery).toHaveBeenCalledTimes(i);
      }

      // Verify it's been called 5 times total (once per interval)
      expect(mockQueryClient.fetchQuery).toHaveBeenCalledTimes(5);

      // Test that it continues after longer periods
      await act(async () => {
        jest.advanceTimersByTime(Time.TEN_MINUTES * 3); // Advance 30 more minutes
      });

      // Should have been called 3 more times (total of 8)
      expect(mockQueryClient.fetchQuery).toHaveBeenCalledTimes(8);
    });

    it('should add window focus event listener', async () => {
      renderHook(() => useHealthCheck(true));

      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      expect(addEventListenerSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    });

    it('should handle window focus correctly when no previous check', async () => {
      renderHook(() => useHealthCheck(true));

      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      // Get the focus handler
      const focusHandler = addEventListenerSpy.mock.calls[0][1];

      // Mock no query state (no previous check)
      mockQueryClient.getQueryState.mockReturnValue(null);
      mockQueryClient.fetchQuery.mockClear();

      // Trigger focus event
      await act(async () => {
        focusHandler();
      });

      expect(mockQueryClient.fetchQuery).toHaveBeenCalledTimes(1);
    });

    it('should handle window focus correctly when check is recent', async () => {
      renderHook(() => useHealthCheck(true));

      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      // Get the focus handler
      const focusHandler = addEventListenerSpy.mock.calls[0][1];

      // Mock recent query state (within 10 minutes)
      mockQueryClient.getQueryState.mockReturnValue({
        dataUpdatedAt: Date.now() - 300000, // 5 minutes ago
      });
      mockQueryClient.fetchQuery.mockClear();

      // Trigger focus event
      await act(async () => {
        focusHandler();
      });

      expect(mockQueryClient.fetchQuery).not.toHaveBeenCalled();
    });

    it('should handle window focus correctly when check is old', async () => {
      renderHook(() => useHealthCheck(true));

      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      // Get the focus handler
      const focusHandler = addEventListenerSpy.mock.calls[0][1];

      // Mock old query state (older than 10 minutes)
      mockQueryClient.getQueryState.mockReturnValue({
        dataUpdatedAt: Date.now() - 700000, // 11+ minutes ago
      });
      mockQueryClient.fetchQuery.mockClear();

      // Trigger focus event
      await act(async () => {
        focusHandler();
      });

      expect(mockQueryClient.fetchQuery).toHaveBeenCalledTimes(1);
    });

    it('should prevent multiple initializations', async () => {
      const { rerender } = renderHook(({ auth }) => useHealthCheck(auth), {
        initialProps: { auth: true },
      });

      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      const initialCallCount = addEventListenerSpy.mock.calls.length;

      // Re-render with same auth state
      rerender({ auth: true });

      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      // Should not add more event listeners
      expect(addEventListenerSpy).toHaveBeenCalledTimes(initialCallCount);
    });

    it('should handle API errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockQueryClient.fetchQuery.mockRejectedValue(new Error('API Error'));

      renderHook(() => useHealthCheck(true));

      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      expect(consoleSpy).toHaveBeenCalledWith('Health check failed:', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });

  describe('cleanup', () => {
    it('should clear intervals on unmount', async () => {
      const { unmount } = renderHook(() => useHealthCheck(true));

      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      unmount();

      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('should remove event listeners on unmount', async () => {
      const { unmount } = renderHook(() => useHealthCheck(true));

      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    });

    it('should clear timeout on unmount before initialization', () => {
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
      const { unmount } = renderHook(() => useHealthCheck(true));

      // Unmount before delay completes
      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  describe('authentication state changes', () => {
    it('should start health check when authentication becomes true', async () => {
      const { rerender } = renderHook(({ auth }) => useHealthCheck(auth), {
        initialProps: { auth: false },
      });

      // Should not start when false
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(mockQueryClient.fetchQuery).not.toHaveBeenCalled();

      // Should start when becomes true
      rerender({ auth: true });

      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      expect(mockQueryClient.fetchQuery).toHaveBeenCalled();
    });
  });
});
