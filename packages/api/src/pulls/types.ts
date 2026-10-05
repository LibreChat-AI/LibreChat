import type { TConversationPullRequest } from 'librechat-data-provider';

/** Stable, user-safe reasons a lookup could not answer. None carries upstream text. */
export const PULL_REQUEST_ERROR_CODES = [
  'NOT_CONFIGURED',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
] as const;
export type PullRequestErrorCode = (typeof PULL_REQUEST_ERROR_CODES)[number];

/** Thrown by a source for an operational failure; the lookup translates it into a result. */
export class PullRequestSourceError extends Error {
  constructor(public readonly code: PullRequestErrorCode) {
    super(`Pull request lookup failed: ${code}`);
    this.name = 'PullRequestSourceError';
  }
}

export type PullRequestFindInput = {
  /** `owner/name`. */
  repo: string;
  branch: string;
  token: string;
};

/** Finds the pull request for a branch. Null is a documented absence, not a failure. */
export type PullRequestSource = {
  find(input: PullRequestFindInput): Promise<TConversationPullRequest | null>;
};

export type PullRequestLookupResult =
  | { ok: true; value: TConversationPullRequest | null }
  | { ok: false; error: { code: PullRequestErrorCode } };

export type PullRequestLookupInput = PullRequestFindInput & { ttlMs: number };

export type PullRequestLookup = (input: PullRequestLookupInput) => Promise<PullRequestLookupResult>;
