import type { IOpenIDLogout, OpenIDAuthorizationMethods } from '@librechat/data-schemas';
import type { LeaseDeps } from '~/admin/lease';
import type { OpenIDLogger } from '../types';
import { ResourcePermissionsUnavailableError } from '~/acl/accessControlService';
import { getSafeErrorMetadata } from '~/utils/errors';
import { withLease } from '~/admin/lease';

const WORKER_LEASE_KEY = 'openid:backchannelLogout:worker';
const DEFAULT_WORKER_INTERVAL_MS = 30_000;
const DEFAULT_WORKER_BATCH_SIZE = 100;

export type BackchannelLogoutWorkerMethods = Pick<
  OpenIDAuthorizationMethods,
  | 'upsertOpenIDSubjectBoundary'
  | 'recordOpenIDLogout'
  | 'markOpenIDLogoutEventEnforced'
  | 'listPendingLogoutEvents'
>;

export interface BackchannelLogoutWorkerDeps {
  methods: BackchannelLogoutWorkerMethods;
  /** Omitted, the worker still runs step 2 on every replica instead of one leader. */
  lease?: LeaseDeps;
  logger: Pick<OpenIDLogger, 'error' | 'warn'>;
  intervalMs?: number;
  batchSize?: number;
  /** Omitted, an enforced event's `expiresAt` is left unset and it never expires. */
  logoutEventRetentionMs?: number;
}

export interface BackchannelLogoutWorker {
  start: () => void;
  stop: () => void;
}

function isLeaseBusyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'RESOURCE_PERMISSIONS_BUSY'
  );
}

/** Replays step 2 for one event left in `received`; idempotent against a concurrent receiver. */
async function enforcePendingEvent(
  methods: BackchannelLogoutWorkerMethods,
  event: IOpenIDLogout,
  revokedAt: Date,
  retentionMs: number | undefined,
): Promise<void> {
  await methods.upsertOpenIDSubjectBoundary({
    issuer: event.issuer,
    clientId: event.clientId,
    subject: event.subject,
    boundaryIat: event.boundaryIat,
  });
  if (event.sid) {
    await methods.recordOpenIDLogout({
      issuer: event.issuer,
      clientId: event.clientId,
      subject: event.subject,
      sid: event.sid,
      revokedAt,
    });
  }
  await methods.markOpenIDLogoutEventEnforced({
    issuer: event.issuer,
    clientId: event.clientId,
    jti: event.jti,
    expiresAt: retentionMs ? new Date(revokedAt.getTime() + retentionMs) : undefined,
  });
}

/** Finishes the receiver's step 2 for events a crash left in `received`. */
export function createBackchannelLogoutWorker(
  deps: BackchannelLogoutWorkerDeps,
): BackchannelLogoutWorker {
  const {
    methods,
    lease,
    logger,
    intervalMs = DEFAULT_WORKER_INTERVAL_MS,
    batchSize = DEFAULT_WORKER_BATCH_SIZE,
    logoutEventRetentionMs,
  } = deps;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function runOnce(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    try {
      await withLease(lease, WORKER_LEASE_KEY, async () => {
        const pending = await methods.listPendingLogoutEvents(batchSize);
        for (const event of pending) {
          try {
            await enforcePendingEvent(methods, event, event.receivedAt, logoutEventRetentionMs);
          } catch (error) {
            logger.error(
              '[openid:backchannelLogout:worker] Failed to enforce a pending logout event',
              getSafeErrorMetadata(error),
            );
          }
        }
      });
    } catch (error) {
      if (error instanceof ResourcePermissionsUnavailableError) {
        /** The lock-store connection is still coming up; expected during startup, not a failure. */
        logger.warn(
          '[openid:backchannelLogout:worker] Lease round skipped; resource permissions unavailable',
          getSafeErrorMetadata(error),
        );
      } else if (!isLeaseBusyError(error)) {
        logger.error(
          '[openid:backchannelLogout:worker] Lease round failed',
          getSafeErrorMetadata(error),
        );
      }
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) {
        return;
      }
      void runOnce();
      timer = setInterval(() => void runOnce(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
