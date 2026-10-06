import {
  PULL_REQUEST_BATCH_MAX,
  PULL_REQUEST_BATCH_TIMEOUT_MAX_SECONDS,
} from 'librechat-data-provider';
import type {
  TConversationPullRequestResponse,
  TConversationPullRequestsResponse,
} from 'librechat-data-provider';

/** A failed entry keeps its stable server code, so a caller can tell a rate limit from an outage. */
export class PullRequestBatchError extends Error {
  constructor(public readonly code: string) {
    super(`Pull request lookup failed: ${code}`);
    this.name = 'PullRequestBatchError';
  }
}

type Waiter = {
  resolve: (value: TConversationPullRequestResponse) => void;
  reject: (reason: unknown) => void;
};

type BatcherOptions = {
  fetchMany: (conversationIds: string[]) => Promise<TConversationPullRequestsResponse>;
  /** How long to gather more ids before asking, so rows mounted together share one request. */
  delayMs?: number;
  /** Ids per request; the server refuses more than its own bound. */
  maxBatch?: number;
  /**
   * Longest a request may hold the queue. Requests go out one at a time, so one that never
   * answers would otherwise stop every later one. It defaults to just past the longest deadline a
   * deployment may configure for the server's own batch, so the server always answers first and
   * the next request never starts while the previous one's lookups are still running.
   */
  requestTimeoutMs?: number;
};

const DEFAULT_DELAY_MS = 30;
const DEFAULT_REQUEST_TIMEOUT_MS = (PULL_REQUEST_BATCH_TIMEOUT_MAX_SECONDS + 10) * 1000;

/**
 * Collects the conversation ids asked for within a short window and fetches them in one request.
 * Each caller gets its own conversation's answer, and callers asking for the same conversation
 * share one entry. A request that fails rejects only the callers it carried.
 */
export function createPullRequestBatcher({
  fetchMany,
  delayMs = DEFAULT_DELAY_MS,
  maxBatch = PULL_REQUEST_BATCH_MAX,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: BatcherOptions) {
  const pending = new Map<string, Waiter[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Requests go out one at a time. Each request lets the server run its own number of lookups at
   * once, so requests in flight together would multiply the limit the operator configured: a long
   * pinned list, or a second flush while one is still out, would otherwise put several times that
   * many lookups on GitHub at once. The tail never rejects, so one failed request cannot stall
   * the ones queued behind it.
   */
  let tail: Promise<void> = Promise.resolve();

  const send = (ids: string[], waiters: Map<string, Waiter[]>): Promise<void> => {
    const settle = ({ results }: TConversationPullRequestsResponse) => {
      const byId = new Map(results.map((entry) => [entry.conversationId, entry]));
      for (const [id, list] of waiters) {
        const entry = byId.get(id);
        for (const waiter of list) {
          if (entry != null && 'error' in entry) {
            waiter.reject(new PullRequestBatchError(entry.error.code));
          } else {
            waiter.resolve({ pullRequest: entry?.pullRequest ?? null });
          }
        }
      }
    };
    const fail = (error: unknown) => {
      for (const list of waiters.values()) list.forEach((waiter) => waiter.reject(error));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PullRequestBatchError('TIMEOUT')), requestTimeoutMs);
    });
    return Promise.race([fetchMany(ids), timedOut])
      .then(settle, fail)
      .finally(() => clearTimeout(timer));
  };

  const flush = () => {
    timer = undefined;
    const ids = [...pending.keys()];
    for (let start = 0; start < ids.length; start += maxBatch) {
      const chunk = ids.slice(start, start + maxBatch);
      const waiters = new Map<string, Waiter[]>();
      for (const id of chunk) {
        waiters.set(id, pending.get(id) ?? []);
        pending.delete(id);
      }
      tail = tail.then(() => send(chunk, waiters));
    }
  };

  return {
    load(conversationId: string): Promise<TConversationPullRequestResponse> {
      return new Promise((resolve, reject) => {
        const waiters = pending.get(conversationId) ?? [];
        waiters.push({ resolve, reject });
        pending.set(conversationId, waiters);
        timer ??= setTimeout(flush, delayMs);
      });
    },
  };
}
