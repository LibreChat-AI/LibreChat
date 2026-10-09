import { logger } from '@librechat/data-schemas';

/** Reply prefix Redis returns for writes sent to a demoted replica. */
export const READONLY_ERROR_PREFIX = 'READONLY';

export type ReconnectableClient = {
  readonly isOpen: boolean;
  readonly isReady: boolean;
  destroy(): void;
  connect(): Promise<unknown>;
};

export type ReadonlyRecoveryOptions = {
  client: ReconnectableClient;
  /**
   * Minimum spacing between reconnect attempts. A failover produces READONLY
   * replies by the hundred per second, and a reconnect issued before the
   * topology settles can land on the demoted node again, so attempts are
   * spaced out and retried on the next error instead of given up on.
   */
  minIntervalMs: number;
  /** Monotonic clock in milliseconds; defaults to `performance.now`. */
  now?: () => number;
  /** Client label used in log lines. */
  label?: string;
};

/** Handler returning whether the error started a reconnect attempt. */
export type ReadonlyRecoveryHandler = (error: unknown) => boolean;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : '';
}

/** Whether an error is a READONLY reply from a Redis node that was demoted to replica. */
export function isReadonlyReplicaError(error: unknown): boolean {
  return errorMessage(error).includes(READONLY_ERROR_PREFIX);
}

/**
 * Creates the READONLY recovery hook for a standalone node-redis client.
 *
 * node-redis only reconnects when its socket closes, and a demoted replica keeps
 * existing sockets open while rejecting every write, so a READONLY reply never
 * reaches `socket.reconnectStrategy`. The returned handler mirrors what ioredis
 * does through `reconnectOnError`: it tears the socket down and reconnects, which
 * re-resolves the connection to whatever the master address now points at.
 *
 * Tearing the socket down rejects the commands queued or in flight at that
 * moment (reads included); node-redis cannot replay them the way ioredis does.
 * That is a bounded, once-per-attempt cost, traded against every write failing
 * until the process restarts.
 *
 * READONLY replies reject straight to the command's promise and never reach the
 * client's error event, so the handler is meant to be called from every error
 * funnel that sees command failures: the Keyv cache error event, Lua scripts
 * evaluated directly against the client, and namespace clears. It debounces
 * internally and never throws.
 *
 * The hook only acts on a client it can reason about: a READONLY reply on a
 * ready socket, or a client its own failed reconnect left closed. While
 * node-redis runs its own reconnect loop (open but not ready) the hook stays
 * out of the way, since a second `connect()` would start a concurrent loop
 * that leaks sockets into one shared reply decoder.
 */
export function createReadonlyRecovery(options: ReadonlyRecoveryOptions): ReadonlyRecoveryHandler {
  const { client, minIntervalMs, label = '@keyv/redis' } = options;
  const now = options.now ?? (() => performance.now());
  let inFlight = false;
  let retryPending = false;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;

  const reconnect = async (): Promise<void> => {
    logger.warn(`${label} client reconnecting due to READONLY error`);
    if (client.isOpen) {
      client.destroy();
    }
    await client.connect();
    logger.info(`${label} client reconnected after READONLY error`);
  };

  const shouldReconnect = (error: unknown): boolean => {
    if (client.isReady) {
      retryPending = false;
      return isReadonlyReplicaError(error);
    }
    return !client.isOpen && retryPending;
  };

  return function recoverIfReadonly(error: unknown): boolean {
    if (inFlight || !shouldReconnect(error)) {
      return false;
    }
    const attemptAt = now();
    if (attemptAt - lastAttemptAt < minIntervalMs) {
      return false;
    }
    inFlight = true;
    lastAttemptAt = attemptAt;
    void reconnect()
      .then(() => {
        retryPending = false;
      })
      .catch((reconnectError: unknown) => {
        retryPending = true;
        logger.error(`${label} client reconnect after READONLY error failed:`, reconnectError);
      })
      .finally(() => {
        inFlight = false;
      });
    return true;
  };
}
