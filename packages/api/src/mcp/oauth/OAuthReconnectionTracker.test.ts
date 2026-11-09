import {
  OAuthReconnectionTracker,
  createOAuthReconnectionTracker,
} from './OAuthReconnectionTracker';

describe('OAuthReconnectTracker', () => {
  let tracker: OAuthReconnectionTracker;
  const userId = 'user123';
  const serverName = 'test-server';
  const anotherServer = 'another-server';

  beforeEach(() => {
    tracker = new OAuthReconnectionTracker();
  });

  describe('setFailed', () => {
    it('should record a failed reconnection attempt', () => {
      tracker.setFailed(userId, serverName);
      expect(tracker.isFailed(userId, serverName)).toBe(true);
    });

    it('should track multiple servers for the same user', () => {
      tracker.setFailed(userId, serverName);
      tracker.setFailed(userId, anotherServer);

      expect(tracker.isFailed(userId, serverName)).toBe(true);
      expect(tracker.isFailed(userId, anotherServer)).toBe(true);
    });

    it('should track different users independently', () => {
      const anotherUserId = 'user456';

      tracker.setFailed(userId, serverName);
      tracker.setFailed(anotherUserId, serverName);

      expect(tracker.isFailed(userId, serverName)).toBe(true);
      expect(tracker.isFailed(anotherUserId, serverName)).toBe(true);
    });
  });

  describe('isFailed', () => {
    it('should return false when no failed attempt is recorded', () => {
      expect(tracker.isFailed(userId, serverName)).toBe(false);
    });

    it('should return true after a failed attempt is recorded', () => {
      tracker.setFailed(userId, serverName);
      expect(tracker.isFailed(userId, serverName)).toBe(true);
    });

    it('should return false for a different server even after another server failed', () => {
      tracker.setFailed(userId, serverName);
      expect(tracker.isFailed(userId, anotherServer)).toBe(false);
    });
  });

  describe('removeFailed', () => {
    it('should clear a failed reconnect record', () => {
      tracker.setFailed(userId, serverName);
      expect(tracker.isFailed(userId, serverName)).toBe(true);

      tracker.removeFailed(userId, serverName);
      expect(tracker.isFailed(userId, serverName)).toBe(false);
    });

    it('should only clear the specific server for the user', () => {
      tracker.setFailed(userId, serverName);
      tracker.setFailed(userId, anotherServer);

      tracker.removeFailed(userId, serverName);

      expect(tracker.isFailed(userId, serverName)).toBe(false);
      expect(tracker.isFailed(userId, anotherServer)).toBe(true);
    });

    it('should handle clearing non-existent records gracefully', () => {
      expect(() => tracker.removeFailed(userId, serverName)).not.toThrow();
    });
  });

  describe('setActive', () => {
    it('should mark a server as reconnecting', () => {
      tracker.setActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(true);
    });

    it('should track multiple reconnecting servers', () => {
      tracker.setActive(userId, serverName);
      tracker.setActive(userId, anotherServer);

      expect(tracker.isActive(userId, serverName)).toBe(true);
      expect(tracker.isActive(userId, anotherServer)).toBe(true);
    });
  });

  describe('isActive', () => {
    it('should return false when server is not reconnecting', () => {
      expect(tracker.isActive(userId, serverName)).toBe(false);
    });

    it('should return true when server is marked as reconnecting', () => {
      tracker.setActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(true);
    });

    it('should handle non-existent user gracefully', () => {
      expect(tracker.isActive('non-existent-user', serverName)).toBe(false);
    });
  });

  describe('removeActive', () => {
    it('should clear reconnecting state for a server', () => {
      tracker.setActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(true);

      tracker.removeActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(false);
    });

    it('should only clear specific server state', () => {
      tracker.setActive(userId, serverName);
      tracker.setActive(userId, anotherServer);

      tracker.removeActive(userId, serverName);

      expect(tracker.isActive(userId, serverName)).toBe(false);
      expect(tracker.isActive(userId, anotherServer)).toBe(true);
    });

    it('should handle clearing non-existent state gracefully', () => {
      expect(() => tracker.removeActive(userId, serverName)).not.toThrow();
    });
  });

  describe('cleanup behavior', () => {
    it('should clean up empty user sets for failed reconnects', () => {
      tracker.setFailed(userId, serverName);
      tracker.removeFailed(userId, serverName);

      // Record and clear another user to ensure internal cleanup
      const anotherUserId = 'user456';
      tracker.setFailed(anotherUserId, serverName);

      // Original user should still be able to reconnect
      expect(tracker.isFailed(userId, serverName)).toBe(false);
    });

    it('should clean up empty user sets for active reconnections', () => {
      tracker.setActive(userId, serverName);
      tracker.removeActive(userId, serverName);

      // Mark another user to ensure internal cleanup
      const anotherUserId = 'user456';
      tracker.setActive(anotherUserId, serverName);

      // Original user should not be reconnecting
      expect(tracker.isActive(userId, serverName)).toBe(false);
    });
  });

  describe('combined state management', () => {
    it('should handle both failed and reconnecting states independently', () => {
      // Mark as reconnecting
      tracker.setActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(true);
      expect(tracker.isFailed(userId, serverName)).toBe(false);

      // Record failed attempt
      tracker.setFailed(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(true);
      expect(tracker.isFailed(userId, serverName)).toBe(true);

      // Clear reconnecting state
      tracker.removeActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(false);
      expect(tracker.isFailed(userId, serverName)).toBe(true);

      // Clear failed state
      tracker.removeFailed(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(false);
      expect(tracker.isFailed(userId, serverName)).toBe(false);
    });
  });

  describe('timeout behavior', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should track timestamp when setting active state', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(true);

      // Verify timestamp was recorded (implementation detail tested via timeout behavior)
      jest.advanceTimersByTime(1000); // 1 second
      expect(tracker.isActive(userId, serverName)).toBe(true);
    });

    it('should handle timeout checking with isStillReconnecting', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setActive(userId, serverName);
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(true);

      // Advance time by 2 minutes 59 seconds - should still be reconnecting
      jest.advanceTimersByTime(2 * 60 * 1000 + 59 * 1000);
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(true);

      // Advance time by 2 more seconds (total 3 minutes 1 second) - should not be still reconnecting
      jest.advanceTimersByTime(2000);
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(false);

      // But isActive should still return true (simple check)
      expect(tracker.isActive(userId, serverName)).toBe(true);
    });

    it('should handle multiple servers with different timeout periods', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      // Set server1 as active
      tracker.setActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(true);

      // Advance 3 minutes
      jest.advanceTimersByTime(3 * 60 * 1000);

      // Set server2 as active
      tracker.setActive(userId, anotherServer);
      expect(tracker.isActive(userId, anotherServer)).toBe(true);
      expect(tracker.isActive(userId, serverName)).toBe(true);

      // Advance 2 more minutes + 1ms (server1 at 5 min + 1ms, server2 at 2 min + 1ms)
      jest.advanceTimersByTime(2 * 60 * 1000 + 1);
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(false); // server1 timed out
      expect(tracker.isStillReconnecting(userId, anotherServer)).toBe(true); // server2 still active

      // Advance 3 more minutes (server2 at 5 min + 1ms)
      jest.advanceTimersByTime(3 * 60 * 1000);
      expect(tracker.isStillReconnecting(userId, anotherServer)).toBe(false); // server2 timed out
    });

    it('should clear timestamp when removing active state', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(true);

      tracker.removeActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(false);

      // Set active again and verify new timestamp is used
      jest.advanceTimersByTime(3 * 60 * 1000);
      tracker.setActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(true);

      // Advance 4 more minutes from new timestamp - should still be active
      jest.advanceTimersByTime(4 * 60 * 1000);
      expect(tracker.isActive(userId, serverName)).toBe(true);
    });

    it('should properly cleanup after timeout occurs', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setActive(userId, serverName);
      tracker.setActive(userId, anotherServer);
      expect(tracker.isActive(userId, serverName)).toBe(true);
      expect(tracker.isActive(userId, anotherServer)).toBe(true);

      // Advance past timeout
      jest.advanceTimersByTime(6 * 60 * 1000);

      // Both should still be in active set but not "still reconnecting"
      expect(tracker.isActive(userId, serverName)).toBe(true);
      expect(tracker.isActive(userId, anotherServer)).toBe(true);
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(false);
      expect(tracker.isStillReconnecting(userId, anotherServer)).toBe(false);

      // Cleanup both
      expect(tracker.cleanupIfTimedOut(userId, serverName)).toBe(true);
      expect(tracker.cleanupIfTimedOut(userId, anotherServer)).toBe(true);

      // Now they should be removed from active set
      expect(tracker.isActive(userId, serverName)).toBe(false);
      expect(tracker.isActive(userId, anotherServer)).toBe(false);
    });

    it('should handle timeout check for non-existent entries gracefully', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      // Check non-existent entry
      expect(tracker.isActive('non-existent', 'non-existent')).toBe(false);
      expect(tracker.isStillReconnecting('non-existent', 'non-existent')).toBe(false);

      // Set and then manually remove
      tracker.setActive(userId, serverName);
      tracker.removeActive(userId, serverName);

      // Advance time and check - should not throw
      jest.advanceTimersByTime(6 * 60 * 1000);
      expect(tracker.isActive(userId, serverName)).toBe(false);
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(false);
    });
  });

  describe('isStillReconnecting', () => {
    it('should return true for active entries within timeout', () => {
      jest.useFakeTimers();
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setActive(userId, serverName);
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(true);

      // Still within timeout
      jest.advanceTimersByTime(3 * 60 * 1000);
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(true);

      jest.useRealTimers();
    });

    it('should return false for timed out entries', () => {
      jest.useFakeTimers();
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setActive(userId, serverName);

      // Advance past timeout
      jest.advanceTimersByTime(6 * 60 * 1000);

      // Should not be still reconnecting
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(false);

      // But isActive should still return true (simple check)
      expect(tracker.isActive(userId, serverName)).toBe(true);

      jest.useRealTimers();
    });

    it('should return false for non-existent entries', () => {
      expect(tracker.isStillReconnecting('non-existent', 'non-existent')).toBe(false);
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(false);
    });
  });

  describe('cleanupIfTimedOut', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should cleanup timed out entries and return true', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(true);

      // Advance past timeout
      jest.advanceTimersByTime(6 * 60 * 1000);

      // Cleanup should return true and remove the entry
      const wasCleanedUp = tracker.cleanupIfTimedOut(userId, serverName);
      expect(wasCleanedUp).toBe(true);
      expect(tracker.isActive(userId, serverName)).toBe(false);
    });

    it('should not cleanup active entries and return false', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setActive(userId, serverName);

      // Within timeout period
      jest.advanceTimersByTime(3 * 60 * 1000);

      const wasCleanedUp = tracker.cleanupIfTimedOut(userId, serverName);
      expect(wasCleanedUp).toBe(false);
      expect(tracker.isActive(userId, serverName)).toBe(true);
    });

    it('should return false for non-existent entries', () => {
      const wasCleanedUp = tracker.cleanupIfTimedOut('non-existent', 'non-existent');
      expect(wasCleanedUp).toBe(false);
    });
  });

  describe('cooldown-based retry', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should return true from isFailed within first cooldown period (5 min)', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setFailed(userId, serverName);
      expect(tracker.isFailed(userId, serverName)).toBe(true);

      jest.advanceTimersByTime(4 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(true);
    });

    it('should return false from isFailed after first cooldown elapses (5 min)', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setFailed(userId, serverName);
      expect(tracker.isFailed(userId, serverName)).toBe(true);

      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(false);
    });

    it('should use progressive cooldown schedule (5m, 10m, 20m, 30m)', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      // First failure: 5 min cooldown
      tracker.setFailed(userId, serverName);
      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(false);

      // Second failure: 10 min cooldown
      tracker.setFailed(userId, serverName);
      jest.advanceTimersByTime(9 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(true);
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(false);

      // Third failure: 20 min cooldown
      tracker.setFailed(userId, serverName);
      jest.advanceTimersByTime(19 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(true);
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(false);

      // Fourth failure: 30 min cooldown
      tracker.setFailed(userId, serverName);
      jest.advanceTimersByTime(29 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(true);
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(false);
    });

    it('should cap cooldown at 30 min for attempts beyond 4', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      for (let i = 0; i < 5; i++) {
        tracker.setFailed(userId, serverName);
        jest.advanceTimersByTime(30 * 60 * 1000);
      }

      tracker.setFailed(userId, serverName);
      jest.advanceTimersByTime(29 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(true);
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(false);
    });

    it('should fully reset metadata on removeFailed', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setFailed(userId, serverName);
      tracker.setFailed(userId, serverName);
      tracker.setFailed(userId, serverName);

      tracker.removeFailed(userId, serverName);
      expect(tracker.isFailed(userId, serverName)).toBe(false);

      tracker.setFailed(userId, serverName);
      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(tracker.isFailed(userId, serverName)).toBe(false);
    });
  });

  describe('timestamp tracking edge cases', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should update timestamp when setting active on already active server', () => {
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setActive(userId, serverName);
      expect(tracker.isActive(userId, serverName)).toBe(true);

      // Advance 3 minutes
      jest.advanceTimersByTime(3 * 60 * 1000);
      expect(tracker.isActive(userId, serverName)).toBe(true);

      // Set active again - should reset timestamp
      tracker.setActive(userId, serverName);

      // Advance 4 more minutes from reset (total 7 minutes from start)
      jest.advanceTimersByTime(4 * 60 * 1000);
      // Should still be active since timestamp was reset at 3 minutes
      expect(tracker.isActive(userId, serverName)).toBe(true);

      // Advance 2 more minutes (6 minutes from reset)
      jest.advanceTimersByTime(2 * 60 * 1000);
      // Should not be still reconnecting (timed out)
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(false);
    });

    it('should handle same server for different users independently', () => {
      const anotherUserId = 'user456';
      const now = Date.now();
      jest.setSystemTime(now);

      tracker.setActive(userId, serverName);

      // Advance 3 minutes
      jest.advanceTimersByTime(3 * 60 * 1000);

      tracker.setActive(anotherUserId, serverName);

      // Advance 3 more minutes
      jest.advanceTimersByTime(3 * 60 * 1000);

      // First user's connection should be timed out
      expect(tracker.isStillReconnecting(userId, serverName)).toBe(false);
      // Second user's connection should still be reconnecting
      expect(tracker.isStillReconnecting(anotherUserId, serverName)).toBe(true);
    });
  });

  describe('failed entry retention', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('drops failed entries that were never retried once retention passes', () => {
      jest.useFakeTimers();
      tracker.setFailed(userId, serverName);
      expect(tracker.getStats().usersWithFailedServers).toBe(1);

      jest.advanceTimersByTime(25 * 60 * 60 * 1000);
      tracker.setFailed('other-user', serverName);

      expect(tracker.isFailed(userId, serverName)).toBe(false);
      expect(tracker.getStats().usersWithFailedServers).toBe(1);
    });

    it('honors mcpSettings.oauthFailureRetentionMs', () => {
      jest.useFakeTimers();
      const short = createOAuthReconnectionTracker({
        mcpSettings: { oauthFailureRetentionMs: 60_000 },
      });
      short.setFailed(userId, serverName);
      jest.advanceTimersByTime(2 * 60_000);
      short.setFailed('other-user', serverName);
      expect(short.getStats().usersWithFailedServers).toBe(1);

      const dflt = createOAuthReconnectionTracker(undefined);
      dflt.setFailed(userId, serverName);
      jest.advanceTimersByTime(2 * 60_000);
      dflt.setFailed('other-user', serverName);
      expect(dflt.getStats().usersWithFailedServers).toBe(2);
    });

    it('prunes promptly when retention is shorter than the prune interval', () => {
      jest.useFakeTimers();
      const tiny = new OAuthReconnectionTracker(1_000);
      tiny.setFailed(userId, serverName);
      tiny.setFailed('warm', serverName);
      jest.advanceTimersByTime(2_000);
      tiny.setFailed('other-user', serverName);
      expect(tiny.getStats().usersWithFailedServers).toBe(1);
    });
  });
});
