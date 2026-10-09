/**
 * `proxy-from-env` ships no types. Declared narrowly rather than pulling in a types package,
 * since only `getProxyForUrl` is used: it returns the proxy URL for a target, applying
 * `<protocol>_proxy` before `all_proxy`, lowercase before uppercase, and `NO_PROXY`, or an
 * empty string when the target should be reached directly.
 */
declare module 'proxy-from-env' {
  export function getProxyForUrl(target: string): string;
}
