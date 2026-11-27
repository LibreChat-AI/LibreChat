import { useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TSchedule } from 'librechat-data-provider';
import { trackScheduledRun, releaseScheduledRun } from '~/data-provider/Schedules/admission';
import { invalidateConversationLists } from '~/utils';

type Occurrences = Pick<TSchedule, 'inFlight' | 'lastRun'>;

const inFlightChats = (schedule: Pick<TSchedule, 'inFlight'>): string[] =>
  (schedule.inFlight ?? []).map((run) => run.conversationId);

/** Everything about a schedule's occurrences that should send the list back to
 *  the server when it moves: which runs are generating, and how the last one
 *  ended. A run short enough to start and settle between two polls is never seen
 *  generating; it is still seen settled, and the refetch that follows brings its
 *  chat with the server's own row. */
const runState = (schedule: Occurrences): string => {
  const { lastRun } = schedule;
  const live = inFlightChats(schedule).sort().join(',');
  return `${live}|${lastRun?.conversationId ?? ''}:${lastRun?.status ?? ''}`;
};

/** A schedule that has never run. What a schedule this client has not seen before
 *  is compared against — and, on the first observation, what every schedule is. */
const IDLE_STATE = runState({});

/**
 * Puts an automatic occurrence's chat in the sidebar, the same way Run Now does.
 *
 * An automatic occurrence is the one generation nothing in this client starts, so
 * no submission, stream or event handler ever tells the sidebar its chat exists —
 * and the list's own five-minute staleness leaves it out of a tab that stays
 * focused. This panel's query is already polling for the cards, and it names the
 * chat each generating occurrence is producing, read from the run's own row rather
 * than inferred from the schedule. Every one is handed to the admission watch Run
 * Now uses, on every observation: that watch is the one place that decides whether
 * an id is landed, in flight, or — having given up on a delivery deferred past its
 * budget — worth trying again. When an occurrence leaves the list it is released,
 * so the watch remembers a run only for as long as this keeps announcing it.
 *
 * `observedAt` is what makes "every observation" true. React Query keeps the
 * previous reference when a refetch is deep-equal, which is exactly what a poll
 * returns while a run stays in flight, so an effect keyed on the data alone would
 * never run again — and a watch that gave up would never be asked to try again.
 *
 * When a run's state moves — one settles, its schedule is deleted from under it,
 * or a schedule created elsewhere arrives with a run already behind it — the list
 * is re-read once for the chat, order and title the settlement changed. Because
 * the state includes the generating occurrences, an owner editing the schedule
 * mid-flight (which fences the `lastRun` projection) still cannot hide a
 * settlement. The first observation has nothing earlier to compare against, so it
 * re-reads if any schedule has run at all: the sidebar may have been read before
 * that run, and nothing here can tell — one refetch on opening the panel is the
 * honest price of that.
 */
export default function useRunSync(schedules?: TSchedule[], observedAt?: number): void {
  const queryClient = useQueryClient();
  const states = useRef<Map<string, string> | null>(null);
  const announced = useRef<Set<string>>(new Set());

  useEffect(
    () => () => {
      for (const conversationId of announced.current) {
        releaseScheduledRun(conversationId);
      }
      announced.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (schedules == null) {
      return;
    }
    const previous = states.current;
    const current = new Map<string, string>();
    const live = new Set<string>();
    for (const schedule of schedules) {
      current.set(schedule.id, runState(schedule));
      for (const conversationId of inFlightChats(schedule)) {
        live.add(conversationId);
        void trackScheduledRun(queryClient, conversationId, { retain: true });
      }
    }
    for (const conversationId of announced.current) {
      if (!live.has(conversationId)) {
        releaseScheduledRun(conversationId);
      }
    }
    announced.current = live;
    states.current = current;
    const moved =
      previous == null
        ? [...current.values()].some((state) => state !== IDLE_STATE)
        : [...previous].some(([id, state]) => current.get(id) !== state) ||
          [...current].some(([id, state]) => !previous.has(id) && state !== IDLE_STATE);
    if (moved) {
      invalidateConversationLists(queryClient);
    }
  }, [schedules, observedAt, queryClient]);
}
