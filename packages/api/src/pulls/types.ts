import type { PullRequestProvider, TConversationPullRequest } from 'librechat-data-provider';

/** Stable, user-safe reasons a lookup could not answer. None carries upstream text. */
export const PULL_REQUEST_ERROR_CODES = [
  'NOT_CONFIGURED',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  /** The provider refused the token itself (401). Answered to clients as `UPSTREAM_ERROR`; a
   *  user's own token is also invalidated, so the account reads as disconnected. */
  'CREDENTIAL_REJECTED',
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
  /** Pages of candidates read per state, so a branch name reused more than one page of times
   *  can still reach an older pull request. One page is what the feature shipped with. */
  maxCandidatePages?: number;
};

export type PullRequestFindInput = {
  /** `owner/name`. */
  repo: string;
  branch: string;
  /** The commit the conversation last ran at; a pull request must carry it to be the match. */
  head?: string | null;
  /**
   * A pull request the conversation's own command output linked to. It is the answer when its
   * head branch is `branch`, whether or not GitHub has the recorded commit yet; otherwise the
   * branch is searched as if no link had been seen.
   */
  pullRequest?: number | null;
  /** Which service to ask, GitHub when omitted. */
  provider?: PullRequestProvider;
  /** The host the token belongs to, the provider's own when omitted. Already normalized. */
  host?: string;
  token: string;
  limits?: PullRequestLookupLimits;
  /** The repositories the token may be used for. A pull request from a fork has its checks read
   *  from the fork only when the fork is named here, so the token never reaches an unlisted one. */
  allowedRepositories?: readonly string[];
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
  /** Read and write the lookup's shared store, when it has one. It never changes the answer, so it
   *  is not part of any cache key. */
  sharedCache?: boolean;
  /** Longest one shared store call may take before the lookup carries on without it. */
  sharedCacheTimeoutMs?: number;
  /** Slots the shared store spreads results over, and again cooldowns; deployment-wide. */
  sharedCacheSlots?: number;
};

/** A value in the shared store: `key` names whose it is, `order` how recent it is. */
export type PullRequestSharedValue = { key: string; order: number };

/**
 * Storage the lookup shares with other replicas, so one answer or one rate limit from the provider
 * serves every replica. Values must round-trip as JSON; `ttlMs` is how long the store may keep one.
 * A call still unsent at `timeoutMs` must be dropped, not left queued, and reject.
 */
export type PullRequestLookupStore = {
  get(key: string, timeoutMs: number): Promise<unknown>;
  /** Stores `value` unless the slot already holds one with the same `key` and an `order` at least
   *  as large, checked and written atomically, so a slower replica's write never replaces a newer
   *  answer and a shorter rate limit never ends a longer one. */
  put(key: string, value: PullRequestSharedValue, ttlMs: number, timeoutMs: number): Promise<void>;
};

export type PullRequestLookup = (input: PullRequestLookupInput) => Promise<PullRequestLookupResult>;
