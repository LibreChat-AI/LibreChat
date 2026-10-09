import { randomUUID } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import type { ConversationMethods } from '@librechat/data-schemas';
import type { AbortResult } from '../../stream/interfaces/IJobStore';
import { isStopConfirmed } from '../../stream/interfaces/IJobStore';

const EVENT_CHILD_LEASE_TTL_MS = 30_000;
const EVENT_CHILD_LEASE_HEARTBEAT_MS = 10_000;
const EVENT_CHILD_ABORT_RETRY_MS = 250;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type EventChildLeaseMethods = Pick<
  ConversationMethods,
  'acquireSubagentThreadLease' | 'renewSubagentThreadLease' | 'releaseSubagentThreadLease'
>;

interface AbortGenerationOptions {
  expectedCreatedAt: number;
  awaitProviderDrain: true;
}

export interface EventChildGenerationLeaseDependencies {
  methods: EventChildLeaseMethods;
  abortGeneration: (streamId: string, options: AbortGenerationOptions) => Promise<AbortResult>;
}

export interface EventChildGenerationLeaseInput {
  userId: string;
  tenantId?: string;
  conversationId: string;
  streamId: string;
  /** Stable logical delivery identity exposed through the parent activity view. */
  taskId?: string;
  jobCreatedAt: number;
  retentionExpiresAt?: Date | string | number;
}

export type ReleaseEventChildGenerationLease = () => Promise<void>;

/** Makes an event-driven child generation visible to the durable deletion protocol. */
export function createEventChildGenerationLeaseAcquirer({
  methods,
  abortGeneration,
}: EventChildGenerationLeaseDependencies) {
  return async function acquireEventChildGenerationLease({
    userId,
    tenantId,
    conversationId,
    streamId,
    taskId,
    jobCreatedAt,
    retentionExpiresAt,
  }: EventChildGenerationLeaseInput): Promise<ReleaseEventChildGenerationLease | null> {
    const token = randomUUID();
    const leaseIdentity = {
      user: userId,
      conversationId,
      token,
      ...(tenantId == null ? {} : { tenantId }),
    };
    const initialTime = Date.now();
    const retentionDeadline =
      retentionExpiresAt == null ? undefined : new Date(retentionExpiresAt).getTime();
    if (
      retentionDeadline != null &&
      (!Number.isFinite(retentionDeadline) || retentionDeadline <= initialTime)
    ) {
      return null;
    }
    const initialLeaseDeadline = Math.min(
      initialTime + EVENT_CHILD_LEASE_TTL_MS,
      retentionDeadline ?? Number.POSITIVE_INFINITY,
    );
    const releaseRejectedLease = async (): Promise<void> => {
      await methods.releaseSubagentThreadLease(leaseIdentity).catch((error) => {
        logger.warn('[EventChildLease] Failed to release a rejected initial lease', { error });
      });
    };
    const acquired = await methods.acquireSubagentThreadLease({
      ...leaseIdentity,
      taskId: taskId ?? streamId,
      now: new Date(initialTime),
      expiresAt: new Date(initialLeaseDeadline),
    });
    if (!acquired) {
      return null;
    }
    const acquiredAt = Date.now();
    if (acquiredAt >= initialLeaseDeadline) {
      await releaseRejectedLease();
      return null;
    }

    let stopped = false;
    let leaseLost = false;
    let heldUntil = initialLeaseDeadline;
    if (
      initialLeaseDeadline !== retentionDeadline &&
      initialLeaseDeadline - acquiredAt <= EVENT_CHILD_LEASE_HEARTBEAT_MS
    ) {
      const refreshedUntil = Math.min(
        acquiredAt + EVENT_CHILD_LEASE_TTL_MS,
        retentionDeadline ?? Number.POSITIVE_INFINITY,
      );
      let refreshed: boolean;
      try {
        refreshed = await methods.renewSubagentThreadLease({
          ...leaseIdentity,
          now: new Date(acquiredAt),
          expiresAt: new Date(refreshedUntil),
        });
      } catch (error) {
        await releaseRejectedLease();
        throw error;
      }
      if (!refreshed || Date.now() >= initialLeaseDeadline) {
        await releaseRejectedLease();
        return null;
      }
      heldUntil = refreshedUntil;
    }
    let renewalInFlight: Promise<void> | undefined;
    let abortInFlight: Promise<void> | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const abortForLostLease = (message: string, error?: unknown): Promise<void> => {
      if (stopped) {
        return Promise.resolve();
      }
      if (abortInFlight != null) {
        return abortInFlight;
      }
      leaseLost = true;
      logger.warn(message, error == null ? undefined : { error });
      /** Retain the durable fence until the exact generation is confirmed stopped.
       * An abort reply can be ambiguous (`job_still_active`, `job_not_found`) and a
       * store/provider failure can throw after the deadline has already fired. The
       * owner therefore retries until abort is authoritative or its own provider
       * finishes and calls `release`, which is the alternate proof of drain. */
      abortInFlight = (async () => {
        while (!stopped) {
          try {
            const result = await abortGeneration(streamId, {
              expectedCreatedAt: jobCreatedAt,
              awaitProviderDrain: true,
            });
            if (isStopConfirmed(result)) {
              return;
            }
            logger.warn('[EventChildLease] Generation stop was not confirmed; retrying', {
              streamId,
              failureReason: result.failureReason,
            });
          } catch (abortError) {
            logger.warn('[EventChildLease] Failed to stop generation after lease loss; retrying', {
              streamId,
              error: abortError,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, EVENT_CHILD_ABORT_RETRY_MS));
        }
      })();
      return abortInFlight;
    };
    const renew = (): void => {
      if (stopped || leaseLost || renewalInFlight != null) {
        return;
      }
      renewalInFlight = (async () => {
        const previousDeadline = heldUntil;
        const renewalTime = Date.now();
        const renewedUntil = Math.min(
          renewalTime + EVENT_CHILD_LEASE_TTL_MS,
          retentionDeadline ?? Number.POSITIVE_INFINITY,
        );
        if (renewedUntil <= renewalTime) {
          await abortForLostLease(
            '[EventChildLease] Generation reached its inherited retention deadline',
          );
          return;
        }
        const held = await methods.renewSubagentThreadLease({
          ...leaseIdentity,
          now: new Date(renewalTime),
          expiresAt: new Date(renewedUntil),
        });
        if (!held || Date.now() >= previousDeadline) {
          await abortForLostLease(
            '[EventChildLease] Generation lost continuous ownership of its lease',
          );
          return;
        }
        heldUntil = renewedUntil;
      })()
        .catch((error) =>
          abortForLostLease('[EventChildLease] Renewal failed; stopping generation', error),
        )
        .finally(() => {
          renewalInFlight = undefined;
        });
    };
    const armRetentionDeadline = (): void => {
      if (retentionDeadline == null || stopped || leaseLost) {
        return;
      }
      const remaining = retentionDeadline - Date.now();
      if (remaining <= 0) {
        void abortForLostLease(
          '[EventChildLease] Generation reached its inherited retention deadline',
        );
        return;
      }
      deadlineTimer = setTimeout(armRetentionDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS));
    };
    const heartbeat = setInterval(renew, EVENT_CHILD_LEASE_HEARTBEAT_MS);
    armRetentionDeadline();

    return async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(deadlineTimer);
      await renewalInFlight;
      await abortInFlight;
      await methods.releaseSubagentThreadLease(leaseIdentity).catch((error) => {
        logger.warn('[EventChildLease] Release failed', { error });
      });
    };
  };
}
