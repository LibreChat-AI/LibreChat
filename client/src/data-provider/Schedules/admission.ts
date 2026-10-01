/* Scheduled chats */
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { TUser, TConversation } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import { extendActiveJobsGrace, queueTitleGeneration } from '~/data-provider/SSE/queries';
import { upsertConvoInAllQueries, getResponseStatus } from '~/utils';

/**
 * Waits before each probe, so the first is not spent on a conversation that
 * cannot exist yet. Admission is normally a second or two, but a dispatch that
 * keeps failing is retried, and the budget has to outlast that or the watch
 * gives up on a run the server is still going to admit: the trigger engine
 * allows eight attempts backing off from a second and doubling, which is about
 * two minutes of retries in the worst case. Roughly five minutes of probes
 * covers that window twice over in eleven requests.
 *
 * It does not cover everything, deliberately. A dispatch refused with a long
 * `Retry-After` can be re-driven hours later, and holding a watch open for that
 * is worse than what already happens without one — the chat arrives with the
 * next list refetch. A later announcement of the same run restarts the watch.
 */
const ADMISSION_DELAYS_MS = [
  750, 1_500, 3_000, 6_000, 10_000, 15_000, 30_000, 45_000, 60_000, 60_000, 60_000,
];

/** 404 is the run not having started yet, which is the whole reason for waiting.
 *  408 and 429 ask to be retried by definition, and a proxy in front of the app
 *  can raise either without the run being involved at all. */
const RETRYABLE_CLIENT_STATUS = new Set([404, 408, 429]);

/**
 * Whether a failed probe has answered the question for good. A 5xx, or a request
 * that never got a response, has not — those are the probe failing rather than the
 * run, and the durable delivery is still free to admit afterwards. Only a client
 * error that is not asking to be retried settles it: waiting longer will not make
 * this client able to read that conversation.
 */
const isTerminalProbeFailure = (error: unknown): boolean => {
  const status = getResponseStatus(error);
  return status != null && status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUS.has(status);
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Who this cache belongs to. Both sign-in and sign-out empty it wholesale, so a
 *  watch outliving either has no business writing to whatever replaced it. An
 *  `undefined` is "not loaded yet" or "emptied", and the two read the same. */
const cacheOwner = (queryClient: QueryClient): string | undefined =>
  queryClient.getQueryData<TUser>([QueryKeys.user])?.id;

/**
 * Runs with a watch in flight. A run can be announced twice — by the click that
 * started it, and by the schedules poll that then lists it — and must be watched
 * once. Bounded by however many generations can actually be running, and never
 * evicted: a second watch for a run still being watched is the one thing this
 * exists to prevent.
 */
const watching = new Map<string, { retain: boolean }>();

/**
 * Runs already landed, so a later announcement is a no-op. A run is announced for
 * as long as it is generating, and the announcer releases it when it stops — so
 * this holds an id exactly as long as something could announce it, and is bounded
 * by real concurrency rather than by a count that could evict a run still being
 * announced. A watch that gave up is in neither set, so a later announcement of a
 * run admitted after the budget can try again.
 */
const landed = new Set<string>();

/** @internal Test seams. */
export function resetTrackedRuns(): void {
  watching.clear();
  landed.clear();
}
export function trackedRunCount(): number {
  return watching.size + landed.size;
}

/** The announcer no longer names this run — it settled, or its schedule went —
 *  so nothing can announce it again, and there is nothing left to remember. */
export function releaseScheduledRun(conversationId: string): void {
  landed.delete(conversationId);
  const watch = watching.get(conversationId);
  if (watch) {
    watch.retain = false;
  }
}

/**
 * The session fence, in one place. The server enforces ownership on the probe
 * itself — a request sent under one account can never return another's chat —
 * so the only dangerous response is one SENT under the account that clicked and
 * LANDING after someone else signed in. That fixes the shape of the fence:
 *
 * - The owner is bound only from a reading taken BEFORE a probe goes out. A
 *   reading taken after one cannot tell a cache that finished loading from a
 *   cache that changed hands, so it is never adopted as the baseline.
 * - Once bound, any different reading — another id, or none — ends the watch.
 * - A successful probe with no baseline yet is not written and not abandoned:
 *   the budget is kept, and the next iteration binds before it probes.
 */
async function admit(queryClient: QueryClient, conversationId: string): Promise<boolean> {
  let startedFor = cacheOwner(queryClient);
  for (const delay of ADMISSION_DELAYS_MS) {
    await wait(delay);
    const before = cacheOwner(queryClient);
    if (startedFor === undefined) {
      startedFor = before;
    } else if (before !== startedFor) {
      return false;
    }
    let conversation: TConversation;
    try {
      conversation = await dataService.getConversationById(conversationId);
    } catch (error) {
      if (isTerminalProbeFailure(error)) {
        return false;
      }
      continue;
    }
    if (startedFor === undefined) {
      continue;
    }
    if (cacheOwner(queryClient) !== startedFor) {
      return false;
    }
    /** The conversation route serves an archived chat; the list query filters one
     *  out. Another tab archiving this run between its first write and this probe
     *  would otherwise put a row in the sidebar that no refetch agrees belongs
     *  there — and the archive was deliberate, so there is nothing else to do. */
    if (conversation.isArchived === true) {
      return true;
    }
    /** Warms the key the chat route reads, so opening the row it just added does
     *  not have to ask again. Absent-only: anything already cached under this id
     *  was put there by the chat itself and knows more than one list read does. */
    queryClient.setQueryData<TConversation>(
      [QueryKeys.conversation, conversationId],
      (current) => current ?? conversation,
    );
    upsertConvoInAllQueries(queryClient, conversation);
    /** The same bookkeeping the foreground path does when a chat lands in a
     *  project: the project's count and recent-activity ordering live on the
     *  project rows, which the conversation caches above do not touch. */
    if (conversation.chatProjectId) {
      queryClient.invalidateQueries([QueryKeys.projects]);
      queryClient.invalidateQueries([QueryKeys.project, conversation.chatProjectId]);
    }
    /** A generation is live by definition here. The active-job list is the only
     *  thing that can mark the row as running, and it stops polling while nothing
     *  is listed — so re-arm it at admission, which is when a job exists, rather
     *  than at the click, which is before one does. */
    extendActiveJobsGrace();
    queryClient.invalidateQueries([QueryKeys.activeJobs]);
    /** A conversation admitted mid-run has not been titled yet, so the row lands
     *  as "New Chat". The foreground paths hand that to the title queue, which
     *  owns the timing the server was configured for; a scheduled run has no
     *  foreground path, so hand it over here rather than leaving the placeholder
     *  until an unrelated refetch. */
    queueTitleGeneration(conversationId);
    return true;
  }
  return false;
}

/**
 * Puts a scheduled run's chat in the sidebar once the server actually has it.
 *
 * The generation that writes the conversation starts after the run is announced
 * — after run-now answers, after the schedules poll first lists the occurrence —
 * so at the moment of the announcement there is nothing to refetch. The
 * conversation route answers 404 until that write commits and applies the same
 * visibility rule the list query does, which makes it an exact admission probe:
 * a 200 means the chat is listable now, and carries the server's own row rather
 * than a guess assembled from the client's cached schedule.
 *
 * `retain` is for a polling owner that will release the id when it stops naming
 * it. One-shot Run Now calls leave no retained id after admission finishes.
 *
 * Deliberately detached from the caller: the sidebar has to gain the chat whether
 * or not the panel the run was announced in is still mounted. Bounded, and it
 * writes only what the server returned — a delivery that never admits leaves
 * every cache exactly as it found it.
 */
export async function trackScheduledRun(
  queryClient: QueryClient,
  conversationId: string,
  { retain = false }: { retain?: boolean } = {},
): Promise<void> {
  const existing = watching.get(conversationId);
  if (existing && retain) {
    existing.retain = true;
  }
  if (!conversationId || existing || landed.has(conversationId)) {
    return;
  }
  const watch = { retain };
  watching.set(conversationId, watch);
  try {
    const admitted = await admit(queryClient, conversationId);
    if (admitted && watch.retain) {
      landed.add(conversationId);
    }
  } finally {
    watching.delete(conversationId);
  }
}
