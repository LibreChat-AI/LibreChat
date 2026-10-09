declare global {
  interface Window {
    /** Defined in `index.html`: unregisters the service worker and reloads, guarded against loops. */
    __lcRecoverStaleAssets?: () => boolean;
    /** Set by `index.html` once a recovery reload is underway in this page. */
    __lcStaleAssetRecoveryPending?: boolean;
  }
}

export const CHUNK_LOAD_ERROR_NAME = 'ChunkLoadError';

const CHUNK_ERROR_MESSAGES = [
  'failed to fetch dynamically imported module',
  'importing a module script failed',
  'error loading dynamically imported module',
  'unable to preload css',
  'loading chunk',
  'loading css chunk',
];

type ErrorShape = {
  name?: unknown;
  message?: unknown;
  cause?: unknown;
};

/**
 * A code-split module that could not be loaded. Thrown when Vite's preload helper resolves a
 * dynamic import to `undefined` after the stale-asset recovery claimed the failure, so the
 * error boundary sees a recognizable chunk failure instead of a `TypeError` from `module.default`.
 */
export class ChunkLoadError extends Error {
  constructor(message = 'Failed to load a code-split module') {
    super(message);
    this.name = CHUNK_LOAD_ERROR_NAME;
  }
}

function matchesChunkError(error: ErrorShape): boolean {
  if (error.name === CHUNK_LOAD_ERROR_NAME) {
    return true;
  }
  if (typeof error.message !== 'string') {
    return false;
  }
  const message = error.message.toLowerCase();
  return CHUNK_ERROR_MESSAGES.some((pattern) => message.includes(pattern));
}

/** True for dynamic-import, chunk and CSS-preload failures, including one wrapped as `cause`. */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const shape: ErrorShape = error;
  if (matchesChunkError(shape)) {
    return true;
  }
  return typeof shape.cause === 'object' && shape.cause !== null && matchesChunkError(shape.cause);
}

export function isStaleAssetRecoveryPending(): boolean {
  return typeof window !== 'undefined' && window.__lcStaleAssetRecoveryPending === true;
}

const outcomes = new WeakMap<object, boolean>();

function startRecovery(): boolean {
  try {
    return window.__lcRecoverStaleAssets?.() === true;
  } catch {
    return false;
  }
}

/**
 * Asks the page-level recovery to reload onto the current build. Returns `false` when its loop
 * guard declines (a recovery already ran moments ago), so callers fall back to the error UI.
 * The outcome is cached per error so re-renders and strict-mode effects ask only once.
 */
export function requestStaleAssetRecovery(error?: unknown): boolean {
  const key = typeof error === 'object' && error !== null ? error : undefined;
  const cached = key ? outcomes.get(key) : undefined;
  if (cached != null) {
    return cached;
  }
  const started = isStaleAssetRecoveryPending() || startRecovery();
  if (key) {
    outcomes.set(key, started);
  }
  return started;
}
