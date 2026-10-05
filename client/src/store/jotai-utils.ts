import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import type { SyncStorage } from 'jotai/vanilla/utils/atomWithStorage';
import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Create a simple atom with localStorage persistence
 * Uses Jotai's atomWithStorage with getOnInit for proper SSR support
 *
 * @param key - localStorage key
 * @param defaultValue - default value if no saved value exists
 * @returns Jotai atom with localStorage persistence
 */
export function createStorageAtom<T>(key: string, defaultValue: T) {
  return atomWithStorage<T>(key, defaultValue, undefined, {
    getOnInit: true,
  });
}

/**
 * Create an atom with localStorage persistence and side effects
 * Useful when you need to apply changes to the DOM or trigger other actions
 *
 * @param key - localStorage key
 * @param defaultValue - default value if no saved value exists
 * @param onWrite - callback function to run when the value changes
 * @returns Jotai atom with localStorage persistence and side effects
 */
export function createStorageAtomWithEffect<T>(
  key: string,
  defaultValue: T,
  onWrite: (value: T) => void,
) {
  const baseAtom = createStorageAtom(key, defaultValue);

  return atom(
    (get) => get(baseAtom),
    (get, set, newValue: T) => {
      set(baseAtom, newValue);
      if (typeof window !== 'undefined') {
        onWrite(newValue);
      }
    },
  );
}

/**
 * Create a SyncStorage adapter that reads/writes to localStorage but does NOT
 * subscribe to browser `storage` events. This prevents cross-tab synchronization
 * for atoms where each tab should maintain independent state.
 *
 * Use this for atoms that represent per-tab working state (e.g., favorites toggle,
 * MCP server selections) rather than user preferences.
 */
export function createTabIsolatedStorage<Value>(): SyncStorage<Value> {
  return {
    getItem(key: string, initialValue: Value): Value {
      if (typeof window === 'undefined') {
        return initialValue;
      }
      try {
        const stored = localStorage.getItem(key);
        if (stored === null) {
          return initialValue;
        }
        return JSON.parse(stored) as Value;
      } catch {
        return initialValue;
      }
    },
    setItem(key: string, newValue: Value): void {
      if (typeof window === 'undefined') {
        return;
      }
      try {
        localStorage.setItem(key, JSON.stringify(newValue));
      } catch {
        // quota exceeded or other write error — silently ignore
      }
    },
    removeItem(key: string): void {
      if (typeof window === 'undefined') {
        return;
      }
      try {
        localStorage.removeItem(key);
      } catch {
        // silently ignore
      }
    },
    // subscribe intentionally omitted — prevents cross-tab sync via storage events
  };
}

/**
 * Create an atom with localStorage persistence that does NOT sync across tabs.
 * Parallels `createStorageAtom` but uses tab-isolated storage.
 *
 * @param key - localStorage key
 * @param defaultValue - default value if no saved value exists
 * @returns Jotai atom with localStorage persistence, isolated per tab
 */
export function createTabIsolatedAtom<T>(key: string, defaultValue: T) {
  return atomWithStorage<T>(key, defaultValue, createTabIsolatedStorage<T>(), {
    getOnInit: true,
  });
}

/**
 * Initialize a value from localStorage and optionally apply it
 * Useful for applying saved values on app startup (e.g., theme, fontSize)
 *
 * @param key - localStorage key
 * @param defaultValue - default value if no saved value exists
 * @param onInit - optional callback to run with the loaded value
 * @returns The loaded value (or default if none exists)
 */
export function initializeFromStorage<T>(
  key: string,
  defaultValue: T,
  onInit?: (value: T) => void,
): T {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return defaultValue;
  }

  try {
    const savedValue = localStorage.getItem(key);
    const value = savedValue ? (JSON.parse(savedValue) as T) : defaultValue;

    if (onInit) {
      onInit(value);
    }

    return value;
  } catch (error) {
    console.error(`Error initializing ${key} from localStorage, using default. Error:`, error);

    // Reset corrupted value
    try {
      localStorage.setItem(key, JSON.stringify(defaultValue));
    } catch (setError) {
      console.error(`Error resetting corrupted ${key} in localStorage:`, setError);
    }

    if (onInit) {
      onInit(defaultValue);
    }

    return defaultValue;
  }
}

/** Validates persisted data and keeps in-memory edits usable when browser storage fails. */
export function createValidatedStorage<T>(
  storage: () => Storage,
  schema: ZodType<T, ZodTypeDef, unknown>,
): SyncStorage<T> {
  const memory = new Map<string, T>();
  const cleared = new Set<string>();
  return {
    getItem(key, initialValue) {
      if (cleared.has(key)) return initialValue;
      if (memory.has(key)) return memory.get(key)!;
      try {
        const raw = storage().getItem(key);
        const parsed = raw == null ? undefined : schema.safeParse(JSON.parse(raw));
        return parsed?.success ? parsed.data : initialValue;
      } catch {
        return initialValue;
      }
    },
    setItem(key, value) {
      cleared.delete(key);
      memory.set(key, value);
      try {
        storage().setItem(key, JSON.stringify(value));
      } catch {
        /* Storage is optional. */
      }
    },
    removeItem(key) {
      cleared.add(key);
      memory.delete(key);
      try {
        storage().removeItem(key);
      } catch {
        /* Storage is optional. */
      }
    },
  };
}

export function createSessionAtom<T>(
  key: string,
  initialValue: T,
  schema: ZodType<T, ZodTypeDef, unknown>,
) {
  return atomWithStorage(
    key,
    initialValue,
    createValidatedStorage(() => sessionStorage, schema),
    { getOnInit: true },
  );
}
