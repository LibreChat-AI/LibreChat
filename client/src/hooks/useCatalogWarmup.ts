import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Feature catalogs (prompts, MCP servers/tools) are not needed to render the
 * initial chat UI, so their queries stay disabled until this store releases
 * them: after first paint, on browser idle, staggered so the requests never
 * land as one burst. Panels that need a catalog sooner call `activateCatalog`
 * and their own loading states cover the wait.
 */
export type CatalogId = 'prompts' | 'mcpServers' | 'mcpTools';

/** Upper bound on how long warmup may wait behind a busy main thread. */
const IDLE_TIMEOUT_MS = 2000;
/** Browsers without `requestIdleCallback` get a short fixed delay instead. */
const IDLE_FALLBACK_MS = 200;
/** Spacing between catalogs, smaller and more commonly used first. */
const STAGGER_MS: Record<CatalogId, number> = {
  prompts: 0,
  mcpServers: 250,
  mcpTools: 750,
};
/** Random jitter so a fleet of users loading at once does not warm in lockstep. */
const MAX_JITTER_MS = 500;

const ready: Record<CatalogId, boolean> = {
  prompts: false,
  mcpServers: false,
  mcpTools: false,
};
const pendingTimers = new Map<CatalogId, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let scheduled = false;
/** Bumped on reset: idle callbacks and their timers capture the value at
 * scheduling time and no-op after a reset, so a logout can never leave a
 * stale callback releasing catalogs into the next session. */
let generation = 0;

function emitChange() {
  listeners.forEach((listener) => listener());
}

function markReady(id: CatalogId) {
  const timer = pendingTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(id);
  }
  if (ready[id]) {
    return;
  }
  ready[id] = true;
  emitChange();
}

/** Releases a catalog immediately, for panels opened before warmup reaches it. */
export function activateCatalog(id: CatalogId) {
  markReady(id);
}

function scheduleIdle(callback: () => void) {
  const scheduledGeneration = generation;
  const runIfCurrent = () => {
    if (scheduledGeneration === generation) {
      callback();
    }
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(runIfCurrent, { timeout: IDLE_TIMEOUT_MS });
    return;
  }
  setTimeout(runIfCurrent, IDLE_FALLBACK_MS);
}

/**
 * Starts the one-time warmup schedule. Mounted from Root once the user is
 * authenticated; every catalog consumer below Root reads the same store.
 * Logout is SPA navigation (no reload) and can unmount Root in the same
 * render that flips `isAuthenticated`, so both the unauthenticated branch
 * and unmount cleanup reset the schedule for the next session.
 */
export function useCatalogWarmup(isAuthenticated: boolean) {
  useEffect(() => {
    if (!isAuthenticated) {
      resetCatalogWarmup();
      return;
    }
    if (scheduled) {
      return;
    }
    scheduled = true;
    (Object.keys(STAGGER_MS) as CatalogId[]).forEach((id) => {
      scheduleIdle(() => {
        pendingTimers.set(
          id,
          setTimeout(() => markReady(id), STAGGER_MS[id] + Math.random() * MAX_JITTER_MS),
        );
      });
    });
    return () => resetCatalogWarmup();
  }, [isAuthenticated]);
}

export function useCatalogReady(id: CatalogId): boolean {
  const subscribe = useCallback((onStoreChange: () => void) => {
    listeners.add(onStoreChange);
    return () => {
      listeners.delete(onStoreChange);
    };
  }, []);
  const getSnapshot = useCallback(() => ready[id], [id]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Clears timers and readiness so the next session warms on its own schedule.
 * Bumping `generation` also voids idle callbacks still pending from the
 * previous schedule, whose handles `scheduleIdle` does not retain. */
export function resetCatalogWarmup() {
  generation++;
  scheduled = false;
  pendingTimers.forEach((timer) => clearTimeout(timer));
  pendingTimers.clear();
  (Object.keys(ready) as CatalogId[]).forEach((id) => {
    ready[id] = false;
  });
  emitChange();
}
