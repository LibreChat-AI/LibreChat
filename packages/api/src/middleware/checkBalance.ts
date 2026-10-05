import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import {
  ViolationTypes,
  MIN_BALANCE_RESERVATION_TTL_MS,
  DEFAULT_BALANCE_RESERVATION_TTL_MS,
} from 'librechat-data-provider';
import type {
  BalanceReservationRequest,
  BalanceReservationRenewal,
  BalanceReservationRelease,
  BalanceReservationResult,
  IBalanceUpdate,
  BalanceConfig,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

interface TxData {
  user: string;
  model?: string;
  endpoint?: string;
  valueKey?: string;
  tokenType?: string;
  amount: number;
  endpointTokenConfig?: unknown;
  generations?: unknown[];
}

export interface CheckBalanceDeps {
  getMultiplier: (params: Record<string, unknown>) => number;
  reserveBalance: (request: BalanceReservationRequest) => Promise<BalanceReservationResult | null>;
  renewBalanceReservation: (params: BalanceReservationRenewal) => Promise<void>;
  releaseBalanceReservation: (params: BalanceReservationRelease) => Promise<void>;
  logViolation: (
    req: unknown,
    res: unknown,
    type: string,
    errorMessage: Record<string, unknown>,
    score: number,
  ) => Promise<void>;
  /** Balance config for lazy initialization when no record exists, and the reservation TTL */
  balanceConfig?: BalanceConfig;
}

/**
 * Credits held for an admitted request until its usage has been recorded. The reservation is
 * renewed every half TTL until released, so only a reservation whose process stopped expires.
 */
export interface BalanceReservation {
  /** Idempotent; stops renewal. A failed release is logged and left to expire. */
  release: () => Promise<void>;
}

/** The balance reservations admitted during one turn. */
export interface BalanceReservations {
  /** Tracks an admission that may still be pending; returns the same promise. */
  track: <T extends BalanceReservation | undefined>(admission: Promise<T>) => Promise<T>;
  /** Keeps the turn's reservations held until `work` settles, such as a run continuing in the background. */
  holdUntil: (work: Promise<unknown>) => void;
  /**
   * Releases every tracked reservation, first waiting for admissions still pending so a
   * reservation that settles after its turn failed is released too, and for work passed to
   * `holdUntil`. Failed admissions hold nothing.
   */
  release: () => Promise<void>;
}

const noReservation = (): undefined => undefined;

export function createBalanceReservations(): BalanceReservations {
  let admissions: Promise<BalanceReservation | undefined>[] = [];
  return {
    track: (admission) => {
      admissions.push(admission.catch(() => undefined));
      return admission;
    },
    holdUntil: (work) => {
      admissions.push(work.then(noReservation, noReservation));
    },
    release: async () => {
      const pending = admissions;
      admissions = [];
      const reservations = await Promise.all(pending);
      await Promise.all(reservations.map((reservation) => reservation?.release()));
    },
  };
}

/** Runs one turn and releases whatever balance reservations it admitted once it settles. */
export async function withBalanceReservations<T>(
  run: (reservations: BalanceReservations) => Promise<T>,
): Promise<T> {
  const reservations = createBalanceReservations();
  try {
    return await run(reservations);
  } finally {
    await reservations.release();
  }
}

/** Node clamps a timer delay above a signed 32-bit millisecond count to 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Keeps an admitted reservation alive until it is released: renews it at half of its stored
 * expiry, measured from the expiry rather than from when the write that stored it settled, so a
 * slow admission or renewal write cannot let the hold expire before the next renewal. A failed
 * renewal retries well within the remaining half so a transient failure does not let it expire.
 */
function holdReservation(
  {
    user,
    reservationId,
    amount,
    ttlMs,
    expiresAt,
  }: { user: string; reservationId: string; amount: number; ttlMs: number; expiresAt: Date },
  deps: Pick<CheckBalanceDeps, 'renewBalanceReservation' | 'releaseBalanceReservation'>,
): BalanceReservation {
  const retryEveryMs = Math.min(ttlMs / 20, 5_000);
  let timer: NodeJS.Timeout | undefined;
  let released: Promise<void> | undefined;

  const schedule = (delayMs: number) => {
    timer = setTimeout(renew, Math.min(delayMs, MAX_TIMER_DELAY_MS));
    timer.unref();
  };

  const scheduleFrom = (storedExpiry: Date) =>
    schedule(Math.max(0, storedExpiry.getTime() - ttlMs / 2 - Date.now()));

  function renew() {
    const renewedExpiry = new Date(Date.now() + ttlMs);
    deps.renewBalanceReservation({ user, reservationId, expiresAt: renewedExpiry }).then(
      () => (released ? undefined : scheduleFrom(renewedExpiry)),
      (error) => {
        logger.error('[Balance.check] Failed to renew balance reservation', { user, error });
        if (!released) {
          schedule(retryEveryMs);
        }
      },
    );
  }

  if (amount > 0) {
    scheduleFrom(expiresAt);
  }

  return {
    release: () => {
      clearTimeout(timer);
      released ??= deps
        .releaseBalanceReservation({ user, reservationId, amount })
        .catch((error) => {
          logger.error('[Balance.check] Failed to release balance reservation', { user, error });
        });
      return released;
    },
  };
}

let warnedInvalidReservationTtl = false;

function getReservationTtlMs(config?: BalanceConfig): number {
  const ttl = config?.reservationTtlMs;
  if (ttl == null) {
    return DEFAULT_BALANCE_RESERVATION_TTL_MS;
  }
  const valid = Number.isFinite(ttl) && ttl > 0;
  const effective = valid
    ? Math.max(ttl, MIN_BALANCE_RESERVATION_TTL_MS)
    : DEFAULT_BALANCE_RESERVATION_TTL_MS;
  if (effective !== ttl && !warnedInvalidReservationTtl) {
    warnedInvalidReservationTtl = true;
    logger.warn('[Balance.check] Adjusting balance.reservationTtlMs', {
      reservationTtlMs: ttl,
      effectiveMs: effective,
      minimumMs: MIN_BALANCE_RESERVATION_TTL_MS,
    });
  }
  return effective;
}

export function buildInitialBalance(
  user: string,
  config?: BalanceConfig,
): IBalanceUpdate | undefined {
  if (config?.startBalance == null) {
    return undefined;
  }
  const fields: IBalanceUpdate = { user, tokenCredits: config.startBalance };
  if (
    config.autoRefillEnabled &&
    config.refillIntervalValue != null &&
    config.refillIntervalUnit != null &&
    config.refillAmount != null
  ) {
    fields.autoRefillEnabled = config.autoRefillEnabled;
    fields.refillIntervalValue = config.refillIntervalValue;
    fields.refillIntervalUnit = config.refillIntervalUnit;
    fields.refillAmount = config.refillAmount;
    fields.lastRefill = new Date();
  }
  return fields;
}

export type BalanceCreditReservationDeps = Pick<
  CheckBalanceDeps,
  'reserveBalance' | 'renewBalanceReservation' | 'releaseBalanceReservation' | 'balanceConfig'
>;

/** Reserves an already-priced amount with the same initialization, renewal and release as chat. */
export async function reserveBalanceCredits(
  { user, amount }: { user: string; amount: number },
  deps: BalanceCreditReservationDeps,
): Promise<{ reservation?: BalanceReservation; balance: BalanceReservationResult | null }> {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('A finite nonnegative credit amount is required.');
  }
  const reservationId = randomUUID();
  const ttlMs = getReservationTtlMs(deps.balanceConfig);
  const expiresAt = new Date(Date.now() + ttlMs);
  const balance = await deps.reserveBalance({
    user,
    reservationId,
    amount,
    expiresAt,
    initialBalance: buildInitialBalance(user, deps.balanceConfig),
  });
  return {
    balance,
    reservation: balance?.reserved
      ? holdReservation({ user, reservationId, amount, ttlMs, expiresAt }, deps)
      : undefined,
  };
}

/**
 * Admits a request against the user's balance and holds its token cost until the returned
 * reservation is released, so concurrent requests are admitted only against credits that no
 * other in-flight request holds. A missing balance record is created from `startBalance`.
 * Throws with the balance info if the credits are insufficient.
 */
export async function checkBalance(
  { req, res, txData }: { req: ServerRequest; res: Response; txData: TxData },
  deps: CheckBalanceDeps,
): Promise<BalanceReservation> {
  const { user, model, endpoint, valueKey, tokenType, amount, endpointTokenConfig } = txData;
  const multiplier = deps.getMultiplier({
    valueKey,
    tokenType,
    model,
    endpoint,
    endpointTokenConfig,
  });
  const tokenCost = amount * multiplier;

  logger.debug('[Balance.check] Reserving token cost', {
    user,
    model,
    endpoint,
    valueKey,
    tokenType,
    amount,
    multiplier,
    tokenCost,
    endpointTokenConfig: !!endpointTokenConfig,
  });

  const { balance: result, reservation } = await reserveBalanceCredits(
    { user, amount: tokenCost },
    deps,
  );

  if (reservation) return reservation;

  if (!result) {
    logger.debug('[Balance.check] No balance record found for user', { user });
  }

  const type = ViolationTypes.TOKEN_BALANCE;
  const errorMessage: Record<string, unknown> = {
    type,
    balance: Math.max(0, result?.balance ?? 0),
    tokenCost,
    promptTokens: txData.amount,
  };

  if (txData.generations && txData.generations.length > 0) {
    errorMessage.generations = txData.generations;
  }

  await deps.logViolation(req, res, type, errorMessage, 0);
  throw new Error(JSON.stringify(errorMessage));
}
