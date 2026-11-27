import type { TMessage } from 'librechat-data-provider';

/** Where the first message of a turn an event subscription started came from. */
export type EventOrigin = {
  /** The event's type id, such as `github.pull_request_review.submitted`. */
  type: string;
  /** `owner/name` of the repository. */
  repo: string;
  /** The pull request's number. */
  number: number;
  /** The account that caused the event. */
  actor: string;
  /** A web address for the review, the comment or the pull request, when there is one. */
  url?: string;
};

/** Only a plain web address is linked: anything else is shown as text. */
function web(value?: string): string | undefined {
  if (value == null) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The origin a message shows, or null for any message an event subscription did not start.
 * The server writes the record on the turn's first message from the event it verified, so
 * a message someone sent, or one a schedule, an API key or a wake-up started, never has one.
 */
export function parseEventOrigin(
  message: Pick<TMessage, 'isCreatedByUser' | 'isUserSubmitted' | 'trigger'> | undefined,
): EventOrigin | null {
  if (message?.isCreatedByUser !== true || message.isUserSubmitted === true) return null;
  const trigger = message.trigger;
  const detail = trigger?.detail;
  if (detail == null || trigger?.subject?.kind !== 'subscription') return null;
  const url = web(detail.url);
  return {
    type: trigger.event.type,
    repo: detail.repo,
    number: detail.number,
    actor: detail.actor,
    ...(url != null && { url }),
  };
}
