import { logger } from '@librechat/data-schemas';
import type {
  IAgentEventActorContextMeta,
  ICompactionSemanticIndexProjection,
} from '@librechat/data-schemas';
import type { Agents } from 'librechat-data-provider';
import type {
  IJobStoreV2,
  JobMetadataPatch,
  SerializableJobData,
  SteerQueueItem,
} from '~/stream/interfaces/IJobStore';
import type { ActivityPhaseSnapshot } from '~/agents/activityPhases/runtime';
import {
  JobStatusTransitionDeadlineError,
  isPendingActionExpired,
  isPendingActionStale,
  PAUSE_PERSISTENCE_TIMEOUT_ERROR,
  PAUSE_PERSISTENCE_TIMEOUT_MS,
} from '~/stream/interfaces/IJobStore';

export interface ApprovalLifecycleCallbacks {
  onPaused?: (streamId: string, createdAt: number) => void;
  onResumed?: (streamId: string, createdAt: number) => void;
  onExpired?: (streamId: string, createdAt: number) => void;
  onPausePersistenceFailed?: (
    streamId: string,
    createdAt: number,
    error: string,
    drainedSteers: SteerQueueItem[],
  ) => void | Promise<void>;
}

export interface ApprovalPauseOptions {
  discoveredTools?: string[];
  activityPhaseSnapshot?: ActivityPhaseSnapshot;
  compactionSemanticIndex?: ICompactionSemanticIndexProjection;
  /** Calibration and fading state at the pause; seeds the resumed run's pruner. */
  contextMeta?: IAgentEventActorContextMeta;
  /** Generation identity observed by the interrupted run. */

  expectedCreatedAt?: number;
  /** Hold Stop/resume until the paused assistant row is durably unfinished. */
  persistencePending?: boolean;
  /** Versioned pointer to the canonical signed Conversation suspension. */
  agentEventSuspension?: import('~/agents/triggers/types').AgentEventSuspensionProjection;
}

export const PENDING_ACTION_EXPIRED_CODE = 'HITL_ACTION_EXPIRED';

export class PendingActionExpiredError extends Error {
  readonly code: typeof PENDING_ACTION_EXPIRED_CODE = PENDING_ACTION_EXPIRED_CODE;

  constructor() {
    super('The pending action expired before it could be exposed for review');
    this.name = 'PendingActionExpiredError';
  }
}

const PAUSE_PERSISTENCE_ACTION_PREFIX = 'pause-persistence:';

export function pausePersistenceActionId(actionId: string): string {
  return `${PAUSE_PERSISTENCE_ACTION_PREFIX}${actionId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The guarded lifecycle of a run paused for human review (`requires_action`).
 *
 * Owns the legal transitions — pause, resolve, expire — behind one interface,
 * on top of the store's atomic {@link IJobStore.transitionStatus}. Callers
 * (approval routes, the status endpoint, the run seam) cross this seam instead
 * of re-implementing the "is this transition legal from the current state, and
 * is it safe under a concurrent second submit" logic at each site.
 *
 * Race-safety is the point. Two approval clicks racing to resume the same job
 * must not both drive the run — a double-drive re-executes tools and
 * double-bills. {@link resolve} returns `true` to exactly one caller; the loser
 * gets `false`. The same guard protects {@link pause} (don't pause a job that
 * was aborted between the interrupt firing and the mark) and {@link expire}.
 *
 * State machine:
 * ```
 *   running ──pause(pendingAction)──▶ requires_action
 *   requires_action ──resolve()──────▶ running
 *   requires_action ──expire()───────▶ aborted   (the edge that was undefined)
 * ```
 */
export class ApprovalLifecycle {
  constructor(
    private readonly store: IJobStoreV2,
    private readonly callbacks: ApprovalLifecycleCallbacks = {},
  ) {}

  /**
   * `running → requires_action`, attaching the pending review record.
   * Returns `false` when the job was not running (aborted mid-flight, gone),
   * so a late interrupt is dropped rather than pausing a dead job.
   */
  async pause(
    streamId: string,
    pendingAction: Agents.PendingAction,
    options: ApprovalPauseOptions = {},
  ): Promise<boolean> {
    if (isPendingActionExpired({ pendingAction })) {
      throw new PendingActionExpiredError();
    }
    const job = await this.store.getJob(streamId);
    if (
      !job ||
      job.status !== 'running' ||
      (options.expectedCreatedAt != null && job.createdAt !== options.expectedCreatedAt)
    ) {
      return false;
    }
    const expectedCreatedAt = options.expectedCreatedAt ?? job.createdAt;
    const discoveredTools = options.discoveredTools;
    const activityPhaseSnapshot = options.activityPhaseSnapshot;
    const compactionSemanticIndex = options.compactionSemanticIndex;
    const contextMeta = options.contextMeta;
    /** The normal receipt TTL matches a running job, but a review pause can
     * live for 24h or an explicit later expiry. The store extends every
     * receipt in the SAME CAS that closes running enqueues: a separate pass
     * before or after the transition leaves either an enqueue or crash gap. */
    const pauseReceiptTtl = Math.max(
      24 * 60 * 60,
      pendingAction.expiresAt != null
        ? Math.ceil((pendingAction.expiresAt - Date.now()) / 1000) + 60
        : 0,
    );
    const persistenceStartedAt = Date.now();
    let ok: boolean;
    try {
      ok = await this.store.transitionStatus(streamId, {
        from: 'running',
        to: 'requires_action',
        // pendingActionId is the flat mirror the atomic resolve/expire guard on.
        patch: {
          pendingAction,
          pendingActionId:
            options.persistencePending === true
              ? pausePersistenceActionId(pendingAction.actionId)
              : pendingAction.actionId,
          ...(options.persistencePending === true && {
            terminalPersistencePending: true,
            terminalPersistenceStartedAt: persistenceStartedAt,
          }),
          ...(discoveredTools != null && discoveredTools.length > 0
            ? { discoveredTools: [...discoveredTools] }
            : {}),
          ...(activityPhaseSnapshot != null ? { activityPhaseSnapshot } : {}),
          ...(compactionSemanticIndex != null ? { compactionSemanticIndex } : {}),
          ...(contextMeta != null ? { contextMeta } : {}),
          ...(options.agentEventSuspension != null
            ? { agentEventSuspension: options.agentEventSuspension }
            : {}),
        },
        /** A re-pause with nothing persistable must not leave the previous
         * segment's calibration and tier on the job for the next resume. */
        ...(contextMeta == null ? { clear: ['contextMeta' as const] } : {}),
        expectCreatedAt: expectedCreatedAt,
        notAfterMs: pendingAction.expiresAt,
        steerReceiptTtlSeconds: pauseReceiptTtl,
      });
    } catch (error) {
      if (error instanceof JobStatusTransitionDeadlineError) {
        throw new PendingActionExpiredError();
      }
      throw error;
    }
    if (ok) {
      this.callbacks.onPaused?.(streamId, expectedCreatedAt);
      logger.debug(
        `[ApprovalLifecycle] paused for review: ${streamId} action=${pendingAction.actionId}`,
      );
    }
    return ok;
  }

  /**
   * True only while this exact paused action still owns the durable response
   * persistence barrier installed by {@link pause}. Terminal and resume CASes
   * wait for the barrier, so a controller that observes `true` may safely write
   * its `unfinished:true` response before releasing it.
   */
  async ownsPausePersistence(
    streamId: string,
    expectedActionId: string,
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    const job = await this.store.getJob(streamId);
    return (
      job?.status === 'requires_action' &&
      job.terminalPersistencePending === true &&
      job.pendingAction?.actionId === expectedActionId &&
      job.pendingActionId === pausePersistenceActionId(expectedActionId) &&
      (expectedCreatedAt == null || job.createdAt === expectedCreatedAt)
    );
  }

  /** Release the exact pause barrier after its required response write settles. */
  async finishPausePersistence(
    streamId: string,
    expectedActionId: string,
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    return this.store.transitionStatus(streamId, {
      from: 'requires_action',
      to: 'requires_action',
      patch: {
        pendingActionId: expectedActionId,
        terminalPersistencePending: false,
      },
      clear: ['terminalPersistenceStartedAt'],
      expectActionId: pausePersistenceActionId(expectedActionId),
      expectCreatedAt: expectedCreatedAt,
    });
  }

  /**
   * Wait for a live pause writer, or recover its lock after the bounded owner
   * deadline. Every requires_action→running/terminal path crosses this helper,
   * making the pause response write linearize before either competing outcome.
   */
  async waitForPausePersistence(
    streamId: string,
    expectedCreatedAt?: number,
  ): Promise<Awaited<ReturnType<IJobStoreV2['getJob']>>> {
    for (;;) {
      const job = await this.store.getJob(streamId);
      if (
        !job ||
        job.status !== 'requires_action' ||
        job.terminalPersistencePending !== true ||
        (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)
      ) {
        return job;
      }

      const startedAt = job.terminalPersistenceStartedAt ?? job.createdAt;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= PAUSE_PERSISTENCE_TIMEOUT_MS) {
        const failed = await this.failStalePausePersistence(
          streamId,
          expectedCreatedAt ?? job.createdAt,
        );
        if (!failed) {
          const current = await this.store.getJob(streamId);
          if (
            current?.createdAt === job.createdAt &&
            current.status === 'requires_action' &&
            current.terminalPersistencePending === true &&
            current.pendingActionId === job.pendingActionId
          ) {
            throw new Error(
              `Unable to safely terminalize stale pause-persistence barrier: ${streamId}`,
            );
          }
        }
        continue;
      }

      await delay(Math.min(25, PAUSE_PERSISTENCE_TIMEOUT_MS - elapsed));
    }
  }

  /**
   * Fail a pause writer whose bounded persistence lease expired. The terminal
   * CAS is fenced to the exact action and generation and parks all accepted
   * steers in the same store transaction. Returning the ordinary action id to
   * callers here would be unsafe: the user, assistant, or conversation rows may
   * never have committed before the writer disappeared.
   */
  async failStalePausePersistence(streamId: string, expectedCreatedAt?: number): Promise<boolean> {
    const job = await this.store.getJob(streamId);
    if (
      !job ||
      job.status !== 'requires_action' ||
      job.terminalPersistencePending !== true ||
      job.pendingActionId == null ||
      (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)
    ) {
      return false;
    }

    const startedAt = job.terminalPersistenceStartedAt ?? job.createdAt;
    if (Date.now() - startedAt < PAUSE_PERSISTENCE_TIMEOUT_MS) {
      return false;
    }

    const completedAt = Date.now();
    const drainedSteers = await this.store.transitionStatusAndDrainSteers(streamId, {
      from: 'requires_action',
      to: 'error',
      expectActionId: job.pendingActionId,
      expectCreatedAt: job.createdAt,
      patch: {
        completedAt,
        error: PAUSE_PERSISTENCE_TIMEOUT_ERROR,
        ...(job.agentEventDeliveryKey != null && { terminalHostActionPending: true }),
      },
      clear: [
        'pendingAction',
        'pendingActionId',
        'terminalPersistencePending',
        'terminalPersistenceStartedAt',
      ],
    });
    if (drainedSteers == null) {
      return false;
    }

    logger.error(`[ApprovalLifecycle] Pause persistence timed out: ${streamId}`);
    try {
      await this.callbacks.onPausePersistenceFailed?.(
        streamId,
        job.createdAt,
        PAUSE_PERSISTENCE_TIMEOUT_ERROR,
        drainedSteers,
      );
    } catch (error) {
      // The durable fail-closed transition already won. Notification/resource
      // cleanup is best-effort here and must not turn resolve() into a retry of
      // an action that is now terminal.
      logger.error(
        `[ApprovalLifecycle] Failed to retire timed-out pause runtime: ${streamId}`,
        error,
      );
    }
    return true;
  }

  /**
   * The pending review record, or `null` when the job isn't awaiting review.
   * A past-`expiresAt` record reads as `null` (lazy expiry) so a stale prompt
   * is never surfaced to a UI or fed to a resume.
   */
  async peek(streamId: string): Promise<Agents.PendingAction | null> {
    const job = await this.store.getJob(streamId);
    if (!job || job.status !== 'requires_action') {
      return null;
    }
    // isPendingActionStale covers both a missing record and a past-expiry one.
    return isPendingActionStale(job) ? null : (job.pendingAction ?? null);
  }

  /**
   * `requires_action → running`, atomically. Returns `true` to the single
   * caller that won the transition; `false` if the job was not paused, was
   * already resumed by a racing submit, no longer matches `expectedActionId`,
   * or had expired — in which case it is moved to a terminal state instead of
   * resumed.
   *
   * Pass `expectedActionId` (the id the user actually decided on, from the
   * approval route) so a stale decision can't resume a job that has since
   * paused for a *different* action. Omit it only for callers with no specific
   * action in hand.
   *
   * The caller MUST treat `false` as "do not drive the run": only the `true`
   * winner may re-enter the agent.
   */
  async resolve(
    streamId: string,
    expectedActionId?: string,
    resumePatch?: JobMetadataPatch,
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    const job = await this.waitForPausePersistence(streamId, expectedCreatedAt);
    if (
      !job ||
      job.status !== 'requires_action' ||
      (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)
    ) {
      return false;
    }
    if (!job.pendingAction) {
      // The prompt was lost (e.g. a malformed record dropped on deserialize).
      // It can't be reviewed, so finalize the job instead of driving a resumed
      // run with no reviewed interrupt payload — consistent with how the active
      // listing and cleanup treat a stale pending action.
      await this.expire(streamId, undefined, job.createdAt);
      return false;
    }
    if (isPendingActionExpired(job)) {
      // Target the exact record observed as expired. If the caller didn't pin an
      // actionId, fall back to the one just read — otherwise a concurrent
      // resume + re-pause for a new action could let this expire abort it.
      await this.expire(streamId, expectedActionId ?? job.pendingAction.actionId, job.createdAt);
      return false;
    }
    /** Translate the resuming owner's transient quote-capability assertion
     * into its execution-bound marker (see `steerQuotesExecutionId`). A
     * legacy resumer never reaches this code — its execution rewrite alone
     * invalidates the previous owner's marker. */
    const { steerQuotesCapable, ...ownerPatch } = resumePatch ?? {};
    const boundPatch = {
      ...ownerPatch,
      ...(steerQuotesCapable === true &&
        typeof ownerPatch.providerExecutionId === 'string' && {
          steerQuotesExecutionId: ownerPatch.providerExecutionId,
        }),
    };
    const resumed = await this.store.transitionStatus(streamId, {
      from: 'requires_action',
      to: 'running',
      /** The old suspension marker must not survive into the resumed provider
       * segment. If that segment re-pauses, its canonical successor is stored
       * before a new marker is published; clearing here makes a terminal job
       * in that gap unambiguously recoverable as an unpublished re-pause. */
      clear: [
        'pendingAction',
        'pendingActionId',
        'agentEventSuspension',
        'providerExecutionStartedId',
      ],
      // Refresh the liveness basis so a long-paused run isn't reaped as stale
      // immediately after resuming (cleanup keys off lastActiveAt).
      /** Ownership can move across replicas on resume. Owner-specific fields
       *  must change in this SAME CAS: once status is `running`, steering
       *  routes are live and may atomically inspect them. */
      patch: { lastActiveAt: Date.now(), ...boundPatch },
      expectActionId: expectedActionId,
      expectCreatedAt: job.createdAt,
    });
    if (resumed) {
      this.callbacks.onResumed?.(streamId, job.createdAt);
    }
    return resumed;
  }

  /**
   * `requires_action → aborted`: the edge that fires when no decision arrives
   * in time. Previously undefined; now an explicit, idempotent terminal
   * transition. Returns `true` to the single caller that expired it. Honors
   * `expectedActionId` for the same stale-decision protection as `resolve`.
   */
  async expire(
    streamId: string,
    expectedActionId?: string,
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    return (await this.expireWithIdentity(streamId, expectedActionId, expectedCreatedAt)) != null;
  }

  /**
   * Expires the observed approval and returns the winning terminal snapshot.
   * Callers that run host lifecycle hooks get the trusted pre-CAS metadata plus
   * the exact status/error/completion fields committed by this transition,
   * without a racy post-transition read (the terminal TTL may remove the hash).
   */
  async expireWithIdentity(
    streamId: string,
    expectedActionId?: string,
    expectedCreatedAt?: number,
    options?: { markHostActionPending?: boolean },
  ): Promise<SerializableJobData | null> {
    const job = await this.waitForPausePersistence(streamId, expectedCreatedAt);
    if (
      !job ||
      job.status !== 'requires_action' ||
      (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)
    ) {
      return null;
    }
    const createdAt = job.createdAt;
    const completedAt = Date.now();
    const error = 'Approval expired before a decision was made';
    const expiredJob: SerializableJobData = {
      ...job,
      status: 'aborted',
      error,
      completedAt,
      ...(options?.markHostActionPending === true && { terminalHostActionPending: true }),
    };
    delete expiredJob.pendingAction;
    delete expiredJob.pendingActionId;
    const ok = await this.store.transitionStatus(streamId, {
      from: 'requires_action',
      to: 'aborted',
      clear: ['pendingAction', 'pendingActionId'],
      // completedAt lets the stores' terminal-cleanup reclaim the job; without
      // it an expired approval lingers in the in-memory map indefinitely. When a host
      // action is owed, `terminalHostActionPending` retains the job (and keeps it
      // enumerable) until the adapter acknowledges — set ATOMICALLY here so a crash right
      // after this CAS still leaves the durable retry evidence.
      patch: {
        error,
        completedAt,
        ...(options?.markHostActionPending === true && { terminalHostActionPending: true }),
      },
      expectActionId: expectedActionId,
      expectCreatedAt: createdAt,
    });
    if (ok) {
      this.callbacks.onExpired?.(streamId, createdAt);
      logger.debug(`[ApprovalLifecycle] expired pending review: ${streamId}`);
    }
    return ok ? expiredJob : null;
  }
}
