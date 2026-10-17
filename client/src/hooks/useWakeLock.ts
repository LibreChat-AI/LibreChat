import { useEffect, useRef } from 'react';

/**
 * Extended Navigator type that includes the Screen Wake Lock API
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
 */
type WakeLockCapableNavigator = Navigator & {
  wakeLock?: {
    request: (type: WakeLockType) => Promise<WakeLockSentinel>;
  };
};

/**
 * Checks if we're in a client-side environment (browser)
 * Prevents SSR issues by verifying window, navigator, and document exist
 */
const isClientEnvironment =
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  typeof document !== 'undefined';

const getNavigator = () => navigator as WakeLockCapableNavigator;

/**
 * Determines if the browser supports the Screen Wake Lock API
 * Checking outside component scope for better performance
 */
const supportsWakeLock = isClientEnvironment && 'wakeLock' in navigator;

/**
 * Enable/disable debug logging for wake lock operations
 * Set to true during development to see wake lock lifecycle events
 */
const DEBUG_WAKE_LOCK = false;

/**
 * Custom hook to prevent screen from sleeping during critical operations
 * Uses the Screen Wake Lock API to keep the device screen active
 *
 * @param shouldHold - Boolean flag indicating whether to acquire/hold the wake lock
 * @returns void - This hook manages wake lock state internally
 *
 * @example
 * ```tsx
 * const isGeneratingResponse = useAtomValue(anySubmittingAtom);
 * useWakeLock(isGeneratingResponse);
 * ```
 *
 * @remarks
 * - Automatically handles page visibility changes (reacquires lock when tab becomes visible)
 * - Properly cleans up lock on unmount or when shouldHold becomes false
 * - Gracefully degrades on browsers without Wake Lock API support
 * - Wake locks are automatically released when user switches tabs
 */
export const useWakeLock = (shouldHold: boolean) => {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!supportsWakeLock) {
      if (DEBUG_WAKE_LOCK) {
        console.log('[WakeLock] API not supported in this browser');
      }
      return;
    }

    /**
     * Flag to prevent operations after effect cleanup
     * Essential for avoiding race conditions when:
     * - Component unmounts while lock is being acquired
     * - shouldHold changes while async operations are in flight
     * - Multiple visibility change events fire in quick succession
     */
    let cancelled = false;
    const { wakeLock } = getNavigator();

    if (!wakeLock) {
      return;
    }

    /**
     * Releases the currently held wake lock
     * Called when: shouldHold becomes false, component unmounts, or before acquiring new lock
     */
    const releaseLock = async () => {
      if (!wakeLockRef.current) {
        return;
      }

      try {
        await wakeLockRef.current.release();
        if (DEBUG_WAKE_LOCK) {
          console.log('[WakeLock] Lock released successfully');
        }
      } catch (error) {
        console.warn('[WakeLock] release failed', error);
      } finally {
        wakeLockRef.current = null;
      }
    };

    /**
     * Requests a new wake lock from the browser
     * Checks multiple conditions before requesting to avoid unnecessary API calls:
     * - shouldHold must be true (user wants lock)
     * - cancelled must be false (effect still active)
     * - document must be visible (API requirement - locks only work in visible tabs)
     * - no existing lock (prevent duplicate locks)
     */
    const requestLock = async () => {
      if (
        !shouldHold ||
        cancelled ||
        document.visibilityState !== 'visible' ||
        wakeLockRef.current
      ) {
        return;
      }

      try {
        const sentinel = await wakeLock.request('screen');
        wakeLockRef.current = sentinel;

        if (DEBUG_WAKE_LOCK) {
          console.log('[WakeLock] Lock acquired successfully');
        }

        /**
         * CRITICAL: Recursive re-acquire logic for automatic lock restoration
         *
         * The browser automatically releases wake locks when:
         * - User switches to a different tab
         * - User minimizes the browser window
         * - Device goes to sleep
         * - User navigates to a different page
         *
         * This handler automatically re-acquires the lock when:
         * 1. The lock is released by the browser
         * 2. The effect is still active (not cancelled)
         * 3. The component still wants to hold the lock (shouldHold is true)
         * 4. The tab is visible again (document.visibilityState === 'visible')
         *
         * This ensures users don't need to manually restart their work after
         * switching tabs during long-running operations like AI response generation.
         */
        const handleRelease = () => {
          wakeLockRef.current = null;
          sentinel.removeEventListener('release', handleRelease);

          if (DEBUG_WAKE_LOCK) {
            console.log('[WakeLock] Lock released, checking if re-acquire needed');
          }

          if (!cancelled && shouldHold && document.visibilityState === 'visible') {
            if (DEBUG_WAKE_LOCK) {
              console.log('[WakeLock] Re-acquiring lock');
            }
            void requestLock();
          }
        };

        sentinel.addEventListener('release', handleRelease);
      } catch (error) {
        console.warn('[WakeLock] request failed', error);
      }
    };

    /**
     * Handles browser tab visibility changes
     * When user returns to the tab, re-acquire the lock if it's still needed
     * This is necessary because wake locks are automatically released when tab becomes hidden
     */
    const handleVisibilityChange = () => {
      if (cancelled) {
        return;
      }

      if (DEBUG_WAKE_LOCK) {
        console.log('[WakeLock] Visibility changed:', document.visibilityState);
      }

      if (document.visibilityState === 'visible' && shouldHold) {
        void requestLock();
      }
    };

    if (shouldHold) {
      void requestLock();
      document.addEventListener('visibilitychange', handleVisibilityChange);
    } else {
      void releaseLock();
    }

    /**
     * Cleanup function runs when:
     * - Component unmounts
     * - shouldHold changes
     * - Effect dependencies change
     *
     * Sets cancelled flag first to prevent any in-flight operations from completing
     * Removes event listeners to prevent memory leaks
     * Releases any held wake lock
     */
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void releaseLock();
    };
  }, [shouldHold]);
};

export default useWakeLock;
