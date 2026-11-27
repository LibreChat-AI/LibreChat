import type { ResumableScheduler } from './run';
import type { FetchStreamStatus } from './host';

/** How long a status read may stay unanswered before its caller treats it as failed. */
export const STATUS_READ_TIMEOUT_MS = 15_000;

/** A status read that never answered within its deadline. */
export class StatusReadTimeoutError extends Error {
  constructor(
    readonly conversationId: string,
    readonly timeoutMs: number,
  ) {
    super(`Status read for ${conversationId} did not answer within ${timeoutMs} ms`);
    this.name = 'StatusReadTimeoutError';
  }
}

/**
 * Bounds every status read. Terminal teardown, reconciliation and the foreground check all wait
 * on one, and each already recovers from a rejected read, but a read that never settles (a
 * request held before it is sent, a dropped connection with no error) would strand the pane in
 * its generating state. Rejecting at the deadline hands the read to that recovery instead.
 */
export function withStatusDeadline(
  fetchStatus: FetchStreamStatus,
  scheduler: Pick<ResumableScheduler, 'setTimeout' | 'clearTimeout'>,
  timeoutMs: number = STATUS_READ_TIMEOUT_MS,
): FetchStreamStatus {
  return (conversationId) =>
    new Promise((resolve, reject) => {
      const timer = scheduler.setTimeout(
        () => reject(new StatusReadTimeoutError(conversationId, timeoutMs)),
        timeoutMs,
      );
      fetchStatus(conversationId).then(
        (status) => {
          scheduler.clearTimeout(timer);
          resolve(status);
        },
        (error: unknown) => {
          scheduler.clearTimeout(timer);
          reject(error);
        },
      );
    });
}
