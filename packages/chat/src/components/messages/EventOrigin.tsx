import { GitPullRequest } from 'lucide-react';
import { useLocalize } from '@librechat/client';
import type { TMessage } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import { parseEventOrigin } from '../../core/parts/origin';

/** The label of each event type the catalog lists. Any other type reads as a GitHub event. */
const LABELS: Readonly<Record<string, string>> = {
  'github.pull_request_review.submitted': 'com_ui_events_origin_review',
  'github.pull_request_review_comment.created': 'com_ui_events_origin_review_comment',
  'github.issue_comment.created': 'com_ui_events_origin_comment',
  'github.check_suite.completed': 'com_ui_events_origin_checks',
  'github.pull_request.closed': 'com_ui_events_origin_closed',
};

/**
 * Where the first message of a turn an event subscription started came from: the event, the
 * pull request it was about, linked, and the account that caused it. Nothing the event's
 * authors wrote beyond those names is shown here: the message itself is the subscription's
 * prompt, and the event's text goes to the model as labelled data.
 */
export default function EventOrigin({
  message,
}: {
  message: Pick<TMessage, 'isCreatedByUser' | 'isUserSubmitted' | 'trigger'>;
}): ReactElement | null {
  const localize = useLocalize();
  const origin = parseEventOrigin(message);
  if (origin == null) return null;
  const event = localize(LABELS[origin.type] ?? 'com_ui_events_origin_generic');
  const item = `${origin.repo}#${origin.number}`;
  return (
    <p className="text-text-secondary mb-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
      <span className="sr-only">
        {localize('com_ui_events_origin', { 0: event, 1: item, 2: origin.actor })}
      </span>
      <GitPullRequest aria-hidden="true" className="size-3.5 shrink-0" />
      <span aria-hidden="true">{event}</span>
      <span aria-hidden="true">·</span>
      {origin.url != null ? (
        <a
          href={origin.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-text-primary min-w-0 truncate underline-offset-2 hover:underline focus-visible:underline"
          aria-label={localize('com_ui_events_origin_open', { 0: item })}
        >
          {item}
        </a>
      ) : (
        <span aria-hidden="true" className="text-text-primary min-w-0 truncate">
          {item}
        </span>
      )}
      <span aria-hidden="true">·</span>
      <span aria-hidden="true" className="min-w-0 truncate">
        {origin.actor}
      </span>
    </p>
  );
}
