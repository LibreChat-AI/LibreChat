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
  constructor(
    public readonly code: PullRequestErrorCode,
    /** For `RATE_LIMITED`: how long GitHub asked callers to wait, when it said. */
    public readonly retryAfterMs?: number,
  ) {
    super(`Pull request lookup failed: ${code}`);
    this.name = 'PullRequestSourceError';
  }
}

/** Operator bounds on one lookup; each defaults to the value the feature shipped with. */
export type PullRequestLookupLimits = {
  /** Longest one GitHub request may take. */
  requestTimeoutMs?: number;
  /** Longest the whole lookup, every request together, may take. */
  lookupTimeoutMs?: number;
  /** Most pages of check runs read before the rollup is reported as still running. */
  maxCheckRunPages?: number;
  /** Most pull requests listed per state when searching a branch's history for the match. */
  maxCandidatePullRequests?: number;
  /** Most candidates compared with the recorded commit before the search gives up. */
  maxHeadComparisons?: number;
};

export type PullRequestFindInput = {
  /** `owner/name`. */
  repo: string;
  branch: string;
  /** The commit the conversation last ran at; a pull request must carry it to be the match. */
  head?: string | null;
  token: string;
  limits?: PullRequestLookupLimits;
};

/** Finds the pull request for a branch. Null is a documented absence, not a failure. */
export type PullRequestSource = {
  find(input: PullRequestFindInput): Promise<TConversationPullRequest | null>;
};

export type PullRequestLookupResult =
  | { ok: true; value: TConversationPullRequest | null }
  | { ok: false; error: { code: PullRequestErrorCode } };

export type PullRequestLookupInput = PullRequestFindInput & {
  ttlMs: number;
  /** Entries the shared cache holds before it evicts the oldest; the lookup's own default if omitted. */
  cacheMaxEntries?: number;
  /** Credentials cached at once; the lookup's own default if omitted. */
  cacheMaxCredentials?: number;
};

export type PullRequestLookup = (input: PullRequestLookupInput) => Promise<PullRequestLookupResult>;
