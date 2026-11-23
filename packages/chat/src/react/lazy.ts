import { createContext, useContext } from 'react';
import type { Provider } from 'react';

/**
 * Runs one on-demand import. The markdown plugin loader calls it, so a host can decide what a
 * failed load means: LibreChat reloads a page whose chunks a newer deploy has removed. The
 * result, or the rejection, must be passed through.
 */
export type LazyImport = <M>(load: () => Promise<M>) => Promise<M>;

const direct: LazyImport = (load) => load();

const LazyImportContext = createContext<LazyImport>(direct);

/** Optional: without it an on-demand import runs as written. */
export const LazyImportProvider: Provider<LazyImport> = LazyImportContext.Provider;

export const useLazyImport = (): LazyImport => useContext(LazyImportContext);
