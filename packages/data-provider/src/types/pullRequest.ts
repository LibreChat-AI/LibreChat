/** Where pull requests are looked up; one per deployment, set by the operator. */
export const PULL_REQUEST_PROVIDERS = ['github', 'gitlab', 'bitbucket'] as const;
export const PULL_REQUEST_STATES = ['open', 'closed', 'merged'] as const;
export const PULL_REQUEST_MERGEABLE = ['clean', 'conflicting', 'unknown'] as const;
export const PULL_REQUEST_CHECKS = ['passing', 'failing', 'running', 'none'] as const;

export type PullRequestProvider = (typeof PULL_REQUEST_PROVIDERS)[number];
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];
export type PullRequestMergeable = (typeof PULL_REQUEST_MERGEABLE)[number];
export type PullRequestChecks = (typeof PULL_REQUEST_CHECKS)[number];

/** The pull request a conversation's code workspace opened, as the chat header shows it. */
export type TConversationPullRequest = {
  number: number;
  title: string;
  /** Page of the pull request (a merge request on GitLab) on its provider. */
  url: string;
  /** Where the pull request lives. Absent from a server that predates providers: GitHub. */
  provider?: PullRequestProvider;
  additions: number;
  deletions: number;
  state: PullRequestState;
  isDraft: boolean;
  /** `unknown` while GitHub is still computing it, and for closed or merged pull requests. */
  mergeable: PullRequestMergeable;
  /** Rollup of the head commit's check runs; `none` when the repository has no checks. */
  checks: PullRequestChecks;
};

/** A started connection: the provider page to send the user to, and how long the flow lasts. */
export type TPullRequestConnectStart = {
  url: string;
  /** Seconds the signed flow stays valid. Absent from a server that predates it: 600. */
  expiresInSeconds?: number;
  /** Names this sign-in, so the client knows when the grant it produced is the stored one. */
  flowId?: string;
};

/** Whether the signed-in user has connected their own account for pull request lookups. */
export type TPullRequestConnection = {
  /** Whether users can connect an account on this deployment at all. */
  configured: boolean;
  provider?: PullRequestProvider;
  /** Whether the user has a stored grant. It can be true while `configured` is false: a grant
   *  made before the app was turned off can, and should, still be disconnected. */
  connected: boolean;
  /** The sign-in that produced the stored grant, so replacing it with another is a change. */
  flowId?: string;
};

/** Most conversations one batch lookup may name. It bounds the fan-out to GitHub of a single
 *  request; the lookups themselves stay governed by the configured limits and cache. */
export const PULL_REQUEST_BATCH_MAX = 50;

/** Version of the batch lookup route. The server advertises it with `pullRequestsEnabled`, and a
 *  client that lists conversations asks for batches only when it matches, so during a rolling
 *  upgrade it never sends a batch to a replica that does not have the route yet. */
export const PULL_REQUEST_BATCH_VERSION = 1 as const;

/** The most a deployment may set `batchTimeoutSeconds` to. The server answers by its own deadline,
 *  so a client that waits just past this never gives up before the server does. */
export const PULL_REQUEST_BATCH_TIMEOUT_MAX_SECONDS = 120;

export type TConversationPullRequestsRequest = { conversationIds: string[] };

/** One conversation's answer: its pull request (null when it has none), or a stable failure code. */
export type TConversationPullRequestsEntry =
  | { conversationId: string; pullRequest: TConversationPullRequest | null }
  | { conversationId: string; error: { code: string } };

/** An array rather than an object keyed by id, so no client-supplied id is ever a property name. */
export type TConversationPullRequestsResponse = { results: TConversationPullRequestsEntry[] };

/** `pullRequest` is null when the conversation has no pull request, which is not an error. */
export type TConversationPullRequestResponse = {
  pullRequest: TConversationPullRequest | null;
};
