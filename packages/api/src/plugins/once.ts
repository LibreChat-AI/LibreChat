const DEFAULT_ONCE_CAPACITY = 10_000;

/**
 * Owner of cross-run "fired once" state for SessionStart and `once: true`
 * plugin hooks, keyed by conversation scope. Naming the owner as a seam lets
 * `/api` substitute a shared conversation-scoped store (e.g. the Redis/keyv
 * cache layer) so once-state survives replicas; the default in-memory store
 * is per-process by design — a multi-replica deployment over-fires rather
 * than ever dropping a hook.
 */
export interface PluginHookOnceStore {
  /** Marks the scope active, refreshing its retention. */
  touch(scope: string): void | Promise<void>;
  /** Records the key within the scope; resolves true only the first time. */
  markOnce(scope: string, key: string): boolean | Promise<boolean>;
}

/**
 * Bounded in-memory store that retains and evicts whole conversation scopes,
 * least-recently-active first. Hook registration touches its scope on every
 * run, so an active conversation keeps all of its once-state — including
 * keys of handlers that match only rarely — and eviction under the capacity
 * bound (which counts conversations, not keys) only reaches the
 * conversations idle longest.
 */
export function createMemoryOnceStore(
  capacity: number = DEFAULT_ONCE_CAPACITY,
): PluginHookOnceStore {
  const scopes = new Map<string, Set<string>>();
  const retain = (scope: string): Set<string> => {
    const existing = scopes.get(scope);
    if (existing !== undefined) {
      scopes.delete(scope);
      scopes.set(scope, existing);
      return existing;
    }
    if (scopes.size >= capacity) {
      const oldest = scopes.keys().next().value;
      if (oldest !== undefined) {
        scopes.delete(oldest);
      }
    }
    const created = new Set<string>();
    scopes.set(scope, created);
    return created;
  };
  return {
    touch(scope: string): void {
      retain(scope);
    },
    markOnce(scope: string, key: string): boolean {
      const keys = retain(scope);
      if (keys.has(key)) {
        return false;
      }
      keys.add(key);
      return true;
    },
  };
}

let store: PluginHookOnceStore = createMemoryOnceStore();

export function setPluginHookOnceStore(next: PluginHookOnceStore | undefined): void {
  store = next ?? createMemoryOnceStore();
}

export function getPluginHookOnceStore(): PluginHookOnceStore {
  return store;
}
