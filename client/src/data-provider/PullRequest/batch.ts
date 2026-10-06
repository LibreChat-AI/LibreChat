import { PULL_REQUEST_BATCH_MAX } from 'librechat-data-provider';
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
};

const DEFAULT_DELAY_MS = 30;

/**
 * Collects the conversation ids asked for within a short window and fetches them in one request.
 * Each caller gets its own conversation's answer, and callers asking for the same conversation
 * share one entry. A request that fails rejects only the callers it carried.
 */
export function createPullRequestBatcher({
  fetchMany,
  delayMs = DEFAULT_DELAY_MS,
  maxBatch = PULL_REQUEST_BATCH_MAX,
}: BatcherOptions) {
  const pending = new Map<string, Waiter[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = (ids: string[], waiters: Map<string, Waiter[]>) => {
    fetchMany(ids).then(
      ({ results }) => {
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
      },
      (error: unknown) => {
        for (const list of waiters.values()) list.forEach((waiter) => waiter.reject(error));
      },
    );
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
      send(chunk, waiters);
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
