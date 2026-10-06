export const PULL_REQUEST_STATES = ['open', 'closed', 'merged'] as const;
export const PULL_REQUEST_MERGEABLE = ['clean', 'conflicting', 'unknown'] as const;
export const PULL_REQUEST_CHECKS = ['passing', 'failing', 'running', 'none'] as const;

export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];
export type PullRequestMergeable = (typeof PULL_REQUEST_MERGEABLE)[number];
export type PullRequestChecks = (typeof PULL_REQUEST_CHECKS)[number];

/** The pull request a conversation's code workspace opened, as the chat header shows it. */
export type TConversationPullRequest = {
  number: number;
  title: string;
  /** GitHub page for the pull request. */
  url: string;
  additions: number;
  deletions: number;
  state: PullRequestState;
  isDraft: boolean;
  /** `unknown` while GitHub is still computing it, and for closed or merged pull requests. */
  mergeable: PullRequestMergeable;
  /** Rollup of the head commit's check runs; `none` when the repository has no checks. */
  checks: PullRequestChecks;
};

/** `pullRequest` is null when the conversation has no pull request, which is not an error. */
export type TConversationPullRequestResponse = {
  pullRequest: TConversationPullRequest | null;
};
