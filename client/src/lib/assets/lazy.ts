import { lazy } from 'react';
import type { LazyExoticComponent } from 'react';
import { ChunkLoadError, isChunkLoadError, requestStaleAssetRecovery } from './recovery';

/** Whatever component type `React.lazy` itself accepts. */
type LazyComponent = Awaited<ReturnType<Parameters<typeof lazy>[0]>>['default'];

/**
 * Required imports opt into recovery here, not in the global Vite handler. Optional imports
 * keep their own failure policy. A missing module becomes a recognizable `ChunkLoadError`.
 */
export function importWithRecovery<M>(load: () => Promise<M>): Promise<M> {
  return load()
    .then((module) => {
      if (module == null) {
        throw new ChunkLoadError();
      }
      return module;
    })
    .catch((error: unknown) => {
      if (isChunkLoadError(error)) {
        requestStaleAssetRecovery(error);
      }
      throw error;
    });
}

/**
 * `React.lazy` for a code-split component whose load failures surface as `ChunkLoadError`.
 * For a named export, map inside `importWithRecovery` so the module is checked first.
 */
export function lazyWithRecovery<T extends LazyComponent>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() => importWithRecovery(load));
}
