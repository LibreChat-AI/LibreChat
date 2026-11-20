import { LocalStorageKeys } from 'librechat-data-provider';
import { FILE_SEARCH_UPLOAD_PREFIX } from './localStorage';
import { FILE_SEARCH_CHOICE_PREFIX } from './choices';

/** Suffix for timestamp entries */
const TIMESTAMP_SUFFIX = '_TIMESTAMP';

/** Duration in milliseconds (2 days) */
const CLEANUP_THRESHOLD = 2 * 24 * 60 * 60 * 1000;

/**
 * Storage keys that should be cleaned up based on timestamps
 * These are conversation-specific keys that can accumulate over time
 */
const TIMESTAMPED_KEYS = [
  LocalStorageKeys.LAST_MCP_,
  LocalStorageKeys.LAST_CODE_TOGGLE_,
  LocalStorageKeys.LAST_WEB_SEARCH_TOGGLE_,
  LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_,
  LocalStorageKeys.LAST_ARTIFACTS_TOGGLE_,
  LocalStorageKeys.LAST_MEMORY_TOGGLE_,
  LocalStorageKeys.PIN_MCP_,
];

/**
 * Set only a timestamp for a key (when the value is handled elsewhere)
 */
export function isTimestampExpired(timestamp: number): boolean {
  return Date.now() - timestamp > CLEANUP_THRESHOLD;
}

export function setTimestamp(key: string): void {
  localStorage.setItem(`${key}${TIMESTAMP_SUFFIX}`, Date.now().toString());
}

export function getTimestamp(key: string): number | null {
  const raw = localStorage.getItem(`${key}${TIMESTAMP_SUFFIX}`);
  const timestamp = raw == null ? NaN : Number(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Get a value from localStorage, checking if it has a valid timestamp
 * Returns null if the value is too old or has no timestamp
 */
export function getTimestampedValue(key: string): string | null {
  const timestampKey = `${key}${TIMESTAMP_SUFFIX}`;
  const timestamp = localStorage.getItem(timestampKey);

  if (!timestamp) {
    // No timestamp exists, return the value but it will be cleaned up on next startup
    return localStorage.getItem(key);
  }

  const age = Date.now() - parseInt(timestamp, 10);
  if (age > CLEANUP_THRESHOLD) {
    // Value is too old, clean it up
    localStorage.removeItem(key);
    localStorage.removeItem(timestampKey);
    return null;
  }

  return localStorage.getItem(key);
}

/**
 * Clean up old localStorage entries based on timestamps
 * This should be called on app startup
 */
export function cleanupTimestampedStorage(): void {
  try {
    const keysToRemove: string[] = [];
    const now = Date.now();

    // Iterate through all localStorage keys
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key === LocalStorageKeys.PIN_MCP_) {
        continue;
      }
      if (key.startsWith(FILE_SEARCH_UPLOAD_PREFIX)) {
        try {
          const intent = JSON.parse(localStorage.getItem(key) ?? 'null') as {
            createdAt?: number;
          } | null;
          if (
            !intent ||
            typeof intent.createdAt !== 'number' ||
            !Number.isFinite(intent.createdAt) ||
            isTimestampExpired(intent.createdAt)
          ) {
            keysToRemove.push(key);
          }
        } catch {
          keysToRemove.push(key);
        }
        continue;
      }

      // Check if this key should be timestamped
      const isTimestampedKey = TIMESTAMPED_KEYS.some(
        (prefix) => key.startsWith(prefix) && !key.includes('pinned'),
      );

      if (isTimestampedKey && !key.endsWith(TIMESTAMP_SUFFIX)) {
        const timestampKey = `${key}${TIMESTAMP_SUFFIX}`;
        const timestamp = localStorage.getItem(timestampKey);

        if (!timestamp) {
          // No timestamp exists for a key that should have one - mark for cleanup
          keysToRemove.push(key);
          continue;
        }

        const age = now - parseInt(timestamp, 10);
        if (age > CLEANUP_THRESHOLD) {
          // Entry is too old - mark for cleanup
          keysToRemove.push(key);
          keysToRemove.push(timestampKey);
        }
      }
    }

    keysToRemove.forEach((key) => {
      localStorage.removeItem(key);
      if (
        key.startsWith(LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_) &&
        !key.endsWith(TIMESTAMP_SUFFIX)
      ) {
        const conversationId = key.slice(LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_.length);
        localStorage.removeItem(`${FILE_SEARCH_CHOICE_PREFIX}${conversationId}`);
      }
    });
  } catch (error) {
    console.error('Error during cleanup of timestamped storage:', error);
  }
}
