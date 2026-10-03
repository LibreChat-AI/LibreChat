import { AsyncLocalStorage } from 'node:async_hooks';

export type GrantFetch = (url: string, options: RequestInit) => Promise<Response>;

/** The SDK stores custom fetch on its configuration and does not accept a grant
 * AbortSignal. Install one context-aware fetch without replacing client auth or
 * cancelling concurrent login/refresh requests that share that configuration. */
export function createSignalBoundGrantRequest<C extends object, T>(deps: {
  request: (config: C, type: string, parameters: Record<string, string>) => Promise<T>;
  getFetch: (config: C) => GrantFetch;
  setFetch: (config: C, fetch: GrantFetch) => void;
}): (
  config: C,
  type: string,
  parameters: Record<string, string>,
  signal?: AbortSignal,
) => Promise<T> {
  const requests = new AsyncLocalStorage<AbortSignal | undefined>();
  const installed = new WeakSet<C>();
  return async (config, type, parameters, signal) => {
    signal?.throwIfAborted();
    if (!installed.has(config)) {
      const original = deps.getFetch(config);
      deps.setFetch(config, (url, options) => {
        const current = requests.getStore();
        if (!current) return original(url, options);
        const combined = options.signal ? AbortSignal.any([current, options.signal]) : current;
        return original(url, { ...options, signal: combined });
      });
      installed.add(config);
    }
    try {
      return await requests.run(signal, () => deps.request(config, type, parameters));
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  };
}

/** Literal-scope validation only. Provider selectors are interpreted by the
 * scheduled consent policy. Scope omission retains the requested literal scope. */
export function hasScheduledOboScopes(granted: string | undefined, required: string): boolean {
  if (granted === undefined) return true;
  const scopes = new Set(granted.split(/\s+/).filter(Boolean));
  return required
    .split(/\s+/)
    .filter(Boolean)
    .every((scope) => scopes.has(scope));
}
