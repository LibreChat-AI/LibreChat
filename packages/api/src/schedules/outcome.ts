import { ContentTypes } from 'librechat-data-provider';

/** How a scheduled generation that reached its terminal response write ended. */
export interface Completion {
  /** The run was stopped before it finished. */
  stopped?: boolean;
  /** An empty preempt boundary truncated the turn. */
  preempted?: boolean;
  /** The graph ran out of steps for the turn. */
  stepLimit?: boolean;
  /** The content parts the run persisted as its response. */
  content?: ReadonlyArray<{ type?: string } | null | undefined> | null;
}

export interface CompletedOutcome {
  status: 'success' | 'error' | 'interrupted';
  error?: string;
}

/**
 * The outcome a scheduled run settles with once its response is persisted.
 *
 * The agent client does not throw a failed model call: it ends the turn with an error part so
 * the conversation shows what went wrong. That turn completes its job like any other, so the
 * error part is the only evidence that the run failed, and reading it here is what lets the
 * schedule count the failure. A run cut short on purpose stays `interrupted`, which neither
 * counts as a failure nor clears the streak. The stored text is fixed: the error part may
 * carry provider wording, and the conversation is where the owner reads it.
 */
export function completedOutcome({
  stopped,
  preempted,
  stepLimit,
  content,
}: Completion): CompletedOutcome {
  if (stopped) {
    return { status: 'interrupted', error: 'Scheduled run was stopped' };
  }
  if (preempted) {
    return { status: 'interrupted', error: 'Scheduled run was interrupted before completion' };
  }
  if (stepLimit) {
    return {
      status: 'interrupted',
      error: 'Scheduled run reached its tool call limit before completion',
    };
  }
  if (content?.some((part) => part?.type === ContentTypes.ERROR)) {
    return { status: 'error', error: 'Scheduled run ended with an error response' };
  }
  return { status: 'success' };
}
