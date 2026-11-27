import { isAxiosError } from 'axios';
import type { AgentEventType, SubscriptionActors, RunGrantView } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

/** Each catalog event, as an owner reads it. */
export const eventLabels: Record<AgentEventType, TranslationKeys> = {
  'github.pull_request_review.submitted': 'com_ui_events_type_review',
  'github.pull_request_review_comment.created': 'com_ui_events_type_review_comment',
  'github.issue_comment.created': 'com_ui_events_type_comment',
  'github.check_suite.completed': 'com_ui_events_type_checks',
  'github.pull_request.closed': 'com_ui_events_type_closed',
};

export const actorLabels: Record<SubscriptionActors, TranslationKeys> = {
  linked: 'com_ui_events_actors_linked',
  write: 'com_ui_events_actors_write',
  any: 'com_ui_events_actors_any',
};

/**
 * What a subscription's grant means for its runs, or nothing when they may use what the owner
 * allowed. A subscription with no grant still runs, with none of the agent's tools.
 */
export const grantLabels: Partial<Record<RunGrantView['state'], TranslationKeys>> = {
  missing: 'com_ui_events_needs_grant',
  changed: 'com_ui_events_needs_regrant',
  expired: 'com_ui_events_grant_expired',
  revoked: 'com_ui_events_needs_grant',
};

const errorLabels: Record<string, TranslationKeys> = {
  subscription_invalid: 'com_ui_events_error_invalid',
  subscription_not_found: 'com_ui_events_error_not_found',
  subscription_conflict: 'com_ui_events_error_conflict',
  agent_unavailable: 'com_ui_events_error_agent',
  connection_not_found: 'com_ui_events_error_connection',
};

/** Only the server's stable codes are shown; its text never is. */
export function eventErrorLabel(error: unknown): TranslationKeys {
  const code = isAxiosError<{ code?: unknown }>(error) ? error.response?.data?.code : undefined;
  return (typeof code === 'string' && errorLabels[code]) || 'com_ui_events_error';
}
