import type { TNearAIAttestationParams, TNearAIVerificationReport } from 'librechat-data-provider';

export type NearAIAttestationState = 'verified' | 'partial' | 'failed';

export interface NearAIAttestationStatus {
  model: string;
  status: NearAIAttestationState;
  scope?: 'model' | 'gateway';
  /** When the deployment evidence was last checked (not when the cache was read). */
  checkedAt: string;
  errorCode?: string;
}

/** Matches the `Fetch` shape the OpenAI client configuration accepts. */
export type NearAIFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NearAICredentials {
  apiKey: string;
  baseURL: string;
  verificationTimeoutMs?: number;
  sessionCacheMax?: number;
  reportCacheMax?: number;
  reportCacheTtlMs?: number;
  owner?: string;
}

export interface NearAIService {
  createFetch(credentials: NearAICredentials): NearAIFetch;
  verify(
    credentials: NearAICredentials,
    model: string,
    refresh?: boolean,
    signal?: AbortSignal,
  ): Promise<NearAIAttestationStatus>;
  reports(
    credentials: NearAICredentials,
    model: string,
    options?: Pick<TNearAIAttestationParams, 'scope' | 'refresh' | 'force'>,
  ): Promise<TNearAIVerificationReport[]>;
}
