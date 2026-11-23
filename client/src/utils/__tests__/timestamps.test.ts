import { LocalStorageKeys } from 'librechat-data-provider';
import { setTimestamp, getTimestampedValue, cleanupTimestampedStorage } from '../timestamps';

describe('timestamps', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  describe('setTimestamp', () => {
    it('should set only timestamp in localStorage', () => {
      const key = 'test-key';

      setTimestamp(key);

      expect(localStorage.getItem(`${key}_TIMESTAMP`)).toBeTruthy();
      expect(localStorage.getItem(key)).toBeNull();
    });
  });

  describe('getTimestampedValue', () => {
    it('should return value if timestamp is valid', () => {
      const key = 'test-key';
      const value = { data: 'test' };

      localStorage.setItem(key, JSON.stringify(value));
      localStorage.setItem(`${key}_TIMESTAMP`, Date.now().toString());

      const result = getTimestampedValue(key);
      expect(result).toBe(JSON.stringify(value));
    });

    it('should return null and clean up if timestamp is too old', () => {
      const key = 'test-key';
      const value = { data: 'test' };
      const oldTimestamp = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago

      localStorage.setItem(key, JSON.stringify(value));
      localStorage.setItem(`${key}_TIMESTAMP`, oldTimestamp.toString());

      const result = getTimestampedValue(key);
      expect(result).toBeNull();
      expect(localStorage.getItem(key)).toBeNull();
      expect(localStorage.getItem(`${key}_TIMESTAMP`)).toBeNull();
    });

    it('should return value if no timestamp exists (backward compatibility)', () => {
      const key = 'test-key';
      const value = { data: 'test' };

      localStorage.setItem(key, JSON.stringify(value));

      const result = getTimestampedValue(key);
      expect(result).toBe(JSON.stringify(value));
    });
  });

  describe('cleanupTimestampedStorage', () => {
    it('should remove entries without timestamps', () => {
      const key = `${LocalStorageKeys.LAST_MCP_}convo-123`;
      localStorage.setItem(key, 'value');

      cleanupTimestampedStorage();

      expect(localStorage.getItem(key)).toBeNull();
    });

    it('should remove old entries with timestamps', () => {
      const key = `${LocalStorageKeys.LAST_CODE_TOGGLE_}convo-456`;
      const oldTimestamp = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago

      localStorage.setItem(key, 'true');
      localStorage.setItem(`${key}_TIMESTAMP`, oldTimestamp.toString());

      cleanupTimestampedStorage();

      expect(localStorage.getItem(key)).toBeNull();
      expect(localStorage.getItem(`${key}_TIMESTAMP`)).toBeNull();
    });

    it('should keep recent entries', () => {
      const key = `${LocalStorageKeys.LAST_WEB_SEARCH_TOGGLE_}convo-789`;
      const recentTimestamp = Date.now() - 1 * 60 * 60 * 1000; // 1 hour ago

      localStorage.setItem(key, 'false');
      localStorage.setItem(`${key}_TIMESTAMP`, recentTimestamp.toString());

      cleanupTimestampedStorage();

      expect(localStorage.getItem(key)).toBe('false');
      expect(localStorage.getItem(`${key}_TIMESTAMP`)).toBe(recentTimestamp.toString());
    });

    it('should not affect non-timestamped keys', () => {
      const regularKey = 'regular-key';
      localStorage.setItem(regularKey, 'value');

      cleanupTimestampedStorage();

      expect(localStorage.getItem(regularKey)).toBe('value');
    });

    it('should purge stale memory toggle entries', () => {
      const key = `${LocalStorageKeys.LAST_MEMORY_TOGGLE_}convo-321`;
      const oldTimestamp = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago

      localStorage.setItem(key, 'true');
      localStorage.setItem(`${key}_TIMESTAMP`, oldTimestamp.toString());

      cleanupTimestampedStorage();

      expect(localStorage.getItem(key)).toBeNull();
      expect(localStorage.getItem(`${key}_TIMESTAMP`)).toBeNull();
    });
  });
});
