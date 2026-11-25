import { DEFAULT_OAUTH_STATE_TTL_MS, openidBackchannelLogoutSchema } from 'librechat-data-provider';
import type { TOpenIdBackchannelLogoutConfig } from 'librechat-data-provider';

export interface BackchannelLogoutRegistration {
  openidBackchannelLogout?: Partial<TOpenIdBackchannelLogoutConfig>;
  oauthStateTtlMs?: number;
}

/** `TOpenIdBackchannelLogoutConfig` with `callbackGraceMs` resolved, never optional. */
export type ResolvedBackchannelLogoutConfig = Omit<
  TOpenIdBackchannelLogoutConfig,
  'callbackGraceMs'
> & {
  callbackGraceMs: number;
};

/** Resolves `registration.openidBackchannelLogout`, flooring `callbackGraceMs` at the
 *  registration's resolved `oauthStateTtlMs` so it always covers a pending login callback. */
export function resolveBackchannelLogoutConfig(
  registration: BackchannelLogoutRegistration | null | undefined,
): ResolvedBackchannelLogoutConfig {
  const parsed = openidBackchannelLogoutSchema.parse(registration?.openidBackchannelLogout ?? {});
  const oauthStateTtlMs = registration?.oauthStateTtlMs ?? DEFAULT_OAUTH_STATE_TTL_MS;
  return { ...parsed, callbackGraceMs: Math.max(parsed.callbackGraceMs ?? 0, oauthStateTtlMs) };
}

/** Memoizes a successful load for the process lifetime. A rejected load is never cached, so the
 *  next call retries instead of reusing the failure or falling back to a default. */
export function createMemoizedConfigLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return function getConfig(): Promise<T> {
    if (!cached) {
      cached = load().catch((error: unknown) => {
        cached = null;
        throw error;
      });
    }
    return cached;
  };
}
