import type { TReasoningCapabilityMap } from 'librechat-data-provider';

/** The slice of a keyed cache the reasoning capability lookup needs. */
export interface ReasoningCapabilityCache {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, ttl?: number) => Promise<unknown>;
}

/** What a caller supplies so the lookup has no hard-wired client or cache. */
export interface ReasoningCapabilityDeps {
  /** Returns one page of the provider's model catalog as parsed JSON. */
  fetchPage: (params: {
    url: string;
    apiKey: string;
    timeoutMs: number;
    /** Static configured headers; the caller adds the API key as a Bearer token. */
    headers: Record<string, string>;
  }) => Promise<unknown>;
  cache: ReasoningCapabilityCache;
}

/**
 * What was read and what could not be: an endpoint in `unavailable` is eligible but its
 * catalog failed, which callers must not confuse with an endpoint whose models report no
 * reasoning. Endpoints that were never eligible (not OpenRouter, user-provided, direct,
 * pinned to one model) appear in neither.
 */
export interface ReasoningCapabilityResult {
  capabilities: TReasoningCapabilityMap;
  unavailable: string[];
  /** Epoch milliseconds at which the earliest catalog behind `capabilities` expires. */
  expiresAt?: number;
}
