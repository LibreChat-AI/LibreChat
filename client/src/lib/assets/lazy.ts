import { lazy } from 'react';
import type { LazyExoticComponent } from 'react';
import { ChunkLoadError } from './recovery';

/** Whatever component type `React.lazy` itself accepts. */
type LazyComponent = Awaited<ReturnType<Parameters<typeof lazy>[0]>>['default'];

/**
 * Runs a dynamic import, turning Vite's "recovery claimed this failure" result (`undefined`)
 * into a `ChunkLoadError` before any caller dereferences the module.
 */
export function importWithRecovery<M>(load: () => Promise<M>): Promise<M> {
  return load().then((module) => {
    if (module == null) {
      throw new ChunkLoadError();
    }
    return module;
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
