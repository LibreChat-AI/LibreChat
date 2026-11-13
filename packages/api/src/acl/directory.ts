import { AsyncLocalStorage } from 'node:async_hooks';

/** Settles even when an injected dependency ignores abort; late results cannot restart the caller. */
export async function runDirectoryOperation<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!signal) return operation();
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const value = await Promise.race([
      cancelled,
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }),
    ]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

type DirectoryFetch = (url: string, options: RequestInit) => Promise<Response>;
interface FetchConfiguration {
  [key: symbol]: DirectoryFetch | undefined;
}

/** Install one transport wrapper per config; concurrent grants carry separate abort contexts. */
export function createDirectoryTokenRunner(
  fetchKey: symbol,
): <T>(
  config: FetchConfiguration,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
) => Promise<T> {
  const context = new AsyncLocalStorage<AbortSignal>();
  const wrapped = new WeakMap<FetchConfiguration, DirectoryFetch>();
  return (config, signal, operation) => {
    if (!signal) return operation();
    if (config[fetchKey] !== wrapped.get(config) || !wrapped.has(config)) {
      const transport: DirectoryFetch = config[fetchKey] ?? ((url, options) => fetch(url, options));
      const scoped: DirectoryFetch = (url, options) => {
        const current = context.getStore();
        if (!current) return transport(url, options);
        return runDirectoryOperation(current, () =>
          transport(url, {
            ...options,
            signal: options.signal ? AbortSignal.any([current, options.signal]) : current,
          }),
        );
      };
      config[fetchKey] = scoped;
      wrapped.set(config, scoped);
    }
    return context.run(signal, () => runDirectoryOperation(signal, operation));
  };
}
