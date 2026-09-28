type StorageName = 'localStorage' | 'sessionStorage';
type StorageHost = Pick<Window, StorageName>;

const STORAGE_NAMES: StorageName[] = ['localStorage', 'sessionStorage'];

/** A session-lived stand-in for Web Storage. Stored keys are reported as own enumerable
 * properties, as on a real `Storage`, so `Object.keys(localStorage)` keeps working. */
export function createMemoryStorage(): Storage {
  const items = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return items.size;
    },
    key: (index: number) => Array.from(items.keys())[index] ?? null,
    getItem: (key: string) => items.get(String(key)) ?? null,
    setItem: (key: string, value: string) => {
      items.set(String(key), String(value));
    },
    removeItem: (key: string) => {
      items.delete(String(key));
    },
    clear: () => items.clear(),
  };

  return new Proxy(storage, {
    get: (target, property, receiver) => {
      if (typeof property !== 'string' || property in target) {
        return Reflect.get(target, property, receiver);
      }
      return items.get(property);
    },
    set: (target, property, value, receiver) => {
      if (typeof property !== 'string' || property in target) {
        return Reflect.set(target, property, value, receiver);
      }
      items.set(property, String(value));
      return true;
    },
    deleteProperty: (target, property) => {
      if (typeof property !== 'string' || property in target) {
        return Reflect.deleteProperty(target, property);
      }
      items.delete(property);
      return true;
    },
    ownKeys: () => Array.from(items.keys()),
    getOwnPropertyDescriptor: (_target, property) => {
      if (typeof property !== 'string' || !items.has(property)) {
        return undefined;
      }
      return { value: items.get(property), writable: true, enumerable: true, configurable: true };
    },
  });
}

function isAccessible(target: StorageHost, name: StorageName): boolean {
  try {
    return target[name] != null;
  } catch {
    return false;
  }
}

/**
 * A browser that denies Web Storage by policy throws a `SecurityError` from the
 * `localStorage`/`sessionStorage` getter itself, which would take down every reader in the
 * app. Where the getter throws, it is replaced with an in-memory storage for the page's
 * lifetime, so the app runs on defaults and remembers nothing across reloads.
 */
export function installStorageFallback(target: StorageHost): StorageName[] {
  return STORAGE_NAMES.filter((name) => {
    if (isAccessible(target, name)) {
      return false;
    }
    const fallback = createMemoryStorage();
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => fallback,
    });
    return true;
  });
}

if (typeof window !== 'undefined') {
  installStorageFallback(window);
}
