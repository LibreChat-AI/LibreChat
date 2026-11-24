import { z } from 'zod';

/** Providers whose events can start or continue an agent run. */
export const AGENT_EVENT_PROVIDERS = ['github'] as const;
export type AgentEventProvider = (typeof AGENT_EVENT_PROVIDERS)[number];

/**
 * Every event an agent can be subscribed to. These are stored values: a subscription lists
 * them, a queued delivery carries one, and the client keys its wording on them, so an entry is
 * never renamed or reused once it has shipped.
 *
 * An id is `<provider>.<event>.<action>`, in the provider's own words: for GitHub, the
 * `X-GitHub-Event` header and the payload's `action`. It therefore also names the webhook
 * event an operator has to enable on the GitHub App.
 */
export const AGENT_EVENT_TYPES = [
  'github.pull_request_review.submitted',
  'github.pull_request_review_comment.created',
  'github.issue_comment.created',
  'github.check_suite.completed',
  'github.pull_request.closed',
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const agentEventTypeSchema = z.enum(AGENT_EVENT_TYPES);

const types: ReadonlySet<string> = new Set(AGENT_EVENT_TYPES);

export function isAgentEventType(value: unknown): value is AgentEventType {
  return typeof value === 'string' && types.has(value);
}
