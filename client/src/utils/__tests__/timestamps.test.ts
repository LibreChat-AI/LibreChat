import { LocalStorageKeys } from 'librechat-data-provider';
import {
  setTimestamp,
  setTimestampedValue,
  getTimestampedValue,
  removeTimestampedValue,
  cleanupTimestampedStorage,
  migrateExistingEntries,
} from '../timestamps';

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

  describe('setTimestampedValue', () => {
    it('should set value and timestamp in localStorage', () => {
      const key = 'test-key';
      const value = { data: 'test' };

      setTimestampedValue(key, value);

      expect(localStorage.getItem(key)).toBe(JSON.stringify(value));
      expect(localStorage.getItem(`${key}_TIMESTAMP`)).toBeTruthy();
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

  describe('removeTimestampedValue', () => {
    it('should remove both value and timestamp', () => {
      const key = 'test-key';

      localStorage.setItem(key, 'value');
      localStorage.setItem(`${key}_TIMESTAMP`, Date.now().toString());

      removeTimestampedValue(key);

      expect(localStorage.getItem(key)).toBeNull();
      expect(localStorage.getItem(`${key}_TIMESTAMP`)).toBeNull();
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

  describe('migrateExistingEntries', () => {
    it('should add timestamps to existing timestamped keys', () => {
      const key1 = `${LocalStorageKeys.LAST_MCP_}convo-111`;
      const key2 = `${LocalStorageKeys.PIN_MCP_}convo-222`;

      localStorage.setItem(key1, '["mcp1", "mcp2"]');
      localStorage.setItem(key2, 'true');

      migrateExistingEntries();

      expect(localStorage.getItem(`${key1}_TIMESTAMP`)).toBeTruthy();
      expect(localStorage.getItem(`${key2}_TIMESTAMP`)).toBeTruthy();
    });

    it('should not overwrite existing timestamps', () => {
      const key = `${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}convo-333`;
      const existingTimestamp = '1234567890';

      localStorage.setItem(key, 'true');
      localStorage.setItem(`${key}_TIMESTAMP`, existingTimestamp);

      migrateExistingEntries();

      expect(localStorage.getItem(`${key}_TIMESTAMP`)).toBe(existingTimestamp);
    });
  });
});
