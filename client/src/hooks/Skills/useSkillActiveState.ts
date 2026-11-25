import { useCallback, useEffect, useMemo } from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import type { TSkillStatesResponse, TSkillSummary } from 'librechat-data-provider';
import {
  useGetSkillStatesQuery,
  useUpdateSkillStatesMutation,
  useGetStartupConfig,
} from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import { logger } from '~/utils';

const EMPTY_STATES: TSkillStatesResponse = {};
type SkillActiveTarget = Pick<TSkillSummary, '_id' | 'author' | 'source'>;

interface WriteQueue {
  pending: TSkillStatesResponse | null;
  inFlight: boolean;
  /**
   * Set when the active user changes so any in-flight flush loop still
   * holding a reference to this queue exits before sending another request
   * under the new user's auth context. Once abandoned, the queue is single-
   * use-dead: callers must create a new one via `getWriteQueue`.
   */
  abandoned: boolean;
}

/**
 * Module-scoped, per-user write queues so every hook instance (SkillList,
 * SkillDetail, etc.) shares a single in-flight slot for the active user.
 * Per-instance refs let two components race full-map POSTs and drop toggles
 * via last-writer-wins. Keying by `userId` prevents pending writes from
 * leaking across account transitions in the same browser tab (logout/login
 * flushing a previous user's snapshot into the new session). `lastSeenUserId`
 * tracks the most recent active identity so we can evict and abandon a prior
 * user's queue entry when the active identity changes.
 */
const writeQueues = new Map<string, WriteQueue>();
let lastSeenUserId: string | null = null;

/** Marks every queue whose userId does not match `activeUserId` as abandoned. */
function abandonOtherQueues(activeUserId: string): void {
  for (const [id, queue] of writeQueues) {
    if (id !== activeUserId) {
      queue.abandoned = true;
      queue.pending = null;
      writeQueues.delete(id);
    }
  }
}

function getWriteQueue(userId: string): WriteQueue {
  if (lastSeenUserId !== null && lastSeenUserId !== userId) {
    abandonOtherQueues(userId);
  }
  lastSeenUserId = userId;
  let queue = writeQueues.get(userId);
  if (!queue) {
    queue = { pending: null, inFlight: false, abandoned: false };
    writeQueues.set(userId, queue);
  }
  return queue;
}

/**
 * Resolves the default active state for a skill the user has never toggled.
 *
 * - Deployment skills default to **active** for every user.
 * - Owned skills (author === currentUser) default to **active**.
 * - Shared skills default to the `defaultActiveOnShare` config value (default `false`).
 */
export function resolveSkillDefaultActive(
  skill: Pick<SkillActiveTarget, 'author' | 'source'>,
  userId: string,
  defaultActiveOnShare: boolean,
): boolean {
  if (skill.source === 'deployment' || skill.author === userId) {
    return true;
  }
  return defaultActiveOnShare;
}

/**
 * Hook for managing per-user skill active/inactive state.
 *
 * The `skillStates` map stores explicit overrides (`{ [skillId]: boolean }`).
 * Skills absent from the map use the source/ownership default: deployment and
 * owned skills -> active, shared skills -> `defaultActiveOnShare` from the
 * interface config. Toggles that
 * land on the resolved default remove the key from the map rather than
 * persisting a redundant entry, keeping `skillStates` strictly an exceptions
 * list (otherwise rapid round-trip toggles would exhaust the 200-entry cap).
 *
 * React Query is the single source of truth. Toggling drives an optimistic
 * mutation that updates the cache, identical to the favorites pattern.
 * Toggling is blocked until the initial fetch succeeds, preventing an empty
 * baseline (from isLoading or a failed GET) from wiping server-side overrides.
 * Writes are serialized via a module-scoped queue so rapid toggles from any
 * hook instance cannot race: only one request is ever in flight, and the
 * latest desired state is sent when the previous one settles. Each toggle
 * reads the latest optimistic state directly from the React Query cache so
 * rapid successive toggles cannot drop earlier changes via stale closure.
 * An `abandoned` flag on the queue guards against cross-session writes: on
 * logout/login, the previous user's queue is marked abandoned so an in-flight
 * flush loop exits instead of posting the stale snapshot under the new auth.
 */
export default function useSkillActiveState() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const queryClient = useQueryClient();
  const configQuery = useGetStartupConfig();
  const getQuery = useGetSkillStatesQuery();
  const updateMutation = useUpdateSkillStatesMutation();

  const userId = user?.id ?? '';

  /**
   * Proactively abandon other users' queues whenever the active identity
   * changes. `getWriteQueue` already handles this on the next toggle, but an
   * in-flight flush loop from the previous user can fire its next iteration
   * before any toggle runs — that iteration would carry the stale payload
   * under the new user's cookies. Running this effect on every userId change
   * closes that window for any hook instance that renders post-login.
   */
  useEffect(() => {
    if (!userId) {
      return;
    }
    abandonOtherQueues(userId);
    lastSeenUserId = userId;
  }, [userId]);

  const defaultActiveOnShare = useMemo(() => {
    const skills = configQuery.data?.interface?.skills;
    if (typeof skills === 'object' && skills !== null && 'defaultActiveOnShare' in skills) {
      return skills.defaultActiveOnShare === true;
    }
    return false;
  }, [configQuery.data]);

  const skillStates = useMemo<TSkillStatesResponse>(
    () => (getQuery.data && typeof getQuery.data === 'object' ? getQuery.data : EMPTY_STATES),
    [getQuery.data],
  );

  const canToggle = !getQuery.isLoading && !getQuery.isError && getQuery.data !== undefined;

  const flush = useCallback(async () => {
    if (!userId) {
      return;
    }
    const queue = getWriteQueue(userId);
    while (queue.pending !== null && !queue.abandoned) {
      const next = queue.pending;
      queue.pending = null;
      queue.inFlight = true;
      try {
        await updateMutation.mutateAsync(next);
      } catch (error) {
        logger.error('Error updating skill states:', error);
        const data = (error as { response?: { data?: { code?: string; limit?: number } } })
          ?.response?.data;
        const message =
          data?.code === 'MAX_SKILL_STATES_EXCEEDED'
            ? localize('com_ui_skill_states_limit', { 0: String(data.limit ?? '') })
            : localize('com_ui_error');
        showToast({ message, status: 'error' });
        queue.pending = null;
        break;
      }
    }
    queue.inFlight = false;
  }, [userId, updateMutation, showToast, localize]);

  const isActive = useCallback(
    (skill: SkillActiveTarget): boolean => {
      const override = skillStates[skill._id];
      if (override !== undefined) {
        return override;
      }
      return resolveSkillDefaultActive(skill, userId, defaultActiveOnShare);
    },
    [skillStates, userId, defaultActiveOnShare],
  );

  const toggle = useCallback(
    (skill: SkillActiveTarget) => {
      if (!canToggle || !userId) {
        return;
      }
      const queue = getWriteQueue(userId);
      const cached =
        queryClient.getQueryData<TSkillStatesResponse>([QueryKeys.skillStates]) ?? EMPTY_STATES;
      const baseline = queue.pending ?? cached;
      const defaultValue = resolveSkillDefaultActive(skill, userId, defaultActiveOnShare);
      const override = baseline[skill._id];
      const currentActive = override !== undefined ? override : defaultValue;
      const nextValue = !currentActive;
      const next = { ...baseline };
      if (nextValue === defaultValue) {
        delete next[skill._id];
      } else {
        next[skill._id] = nextValue;
      }
      queue.pending = next;
      if (!queue.inFlight) {
        flush();
      }
    },
    [queryClient, userId, defaultActiveOnShare, canToggle, flush],
  );

  /** Both dependencies feed `isActive`: the override map and the interface
   *  config behind `defaultActiveOnShare`. Until each resolves the map reads
   *  empty and the default reads `false`, so they are reported as one signal.
   *  A consumer gating on `isLoading`/`isError` then cannot silently miss a
   *  dependency, and `isActive` is trustworthy exactly when both are clear. */
  const isLoading = getQuery.isLoading || configQuery.isLoading;
  const isError = getQuery.isError || configQuery.isError;
  const refetchStates = getQuery.refetch;
  const refetchConfig = configQuery.refetch;
  const refetch = useCallback(async () => {
    await Promise.all([refetchStates(), refetchConfig()]);
  }, [refetchStates, refetchConfig]);

  return {
    skillStates,
    defaultActiveOnShare,
    isActive,
    toggle,
    isLoading,
    isError,
    /** Lets a consumer that gates its own UI on resolved states retry both. */
    refetch,
    isUpdating: updateMutation.isLoading,
  };
}
