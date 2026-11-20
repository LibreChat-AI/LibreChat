import type { OpenIDLogger, SessionOpenIDTokens } from './types';
import type { OpenIDRefreshFlightService } from './flight';

const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_DELAY_MS = 25;

type DeliveryFlightService = Pick<
  OpenIDRefreshFlightService,
  | 'assertOpenIDRefreshSessionGenerationAvailable'
  | 'claimOpenIDRefreshFlightDelivery'
  | 'assertOpenIDRefreshFlightDeliveryAvailable'
  | 'releaseOpenIDRefreshFlightDelivery'
>;

/** The parts of an Express response that delivery tracking reads. */
export interface OpenIDDeliveryResponse {
  closed?: boolean;
  once?: (event: 'finish' | 'close', listener: () => void) => unknown;
}

type DeliveryTokens = Pick<
  SessionOpenIDTokens,
  'publicationFlightKey' | 'publicationFlightOwnerId' | 'publicationFlightCreatedAt'
>;

export interface OpenIDResponseDeliveryInput {
  res: OpenIDDeliveryResponse;
  openidTokens?: DeliveryTokens | null;
  context: string;
}

/** Runs the final authorization check, then the synchronous write, under the delivery lease. */
export type SendAuthorized = <T>(send: () => T) => Promise<T>;

export interface OpenIDResponseDeliveryDeps {
  flight: DeliveryFlightService;
  logger: Pick<OpenIDLogger, 'warn'>;
}

/**
 * Serializes response delivery for one durable OpenID publication generation. A logout that
 * reaches the same flight either tombstones it before this claim or waits for the response to
 * finish before returning. The send callback keeps the final authorization check adjacent to the
 * synchronous Express write while allowing callers to do slow preparation under the lease.
 * A response whose client already disconnected never emits `finish` or `close` again, so its
 * lease is released directly after the send instead of through response listeners.
 */
export function createOpenIDResponseDelivery({ flight, logger }: OpenIDResponseDeliveryDeps) {
  const assertReusableSessionGeneration = (openidTokens?: DeliveryTokens | null) =>
    flight.assertOpenIDRefreshSessionGenerationAvailable({
      key: openidTokens?.publicationFlightKey,
      ownerId: openidTokens?.publicationFlightOwnerId,
    });

  return async function withOpenIDResponseDelivery<T>(
    { res, openidTokens, context }: OpenIDResponseDeliveryInput,
    operation: (sendAuthorized: SendAuthorized) => Promise<T>,
  ): Promise<T> {
    let delivery: { key: string; ownerId: string; deliveryId: string } | undefined;
    let responseSent = false;
    let releaseStarted = false;
    let listenersArmed = false;
    const releaseDelivery = async () => {
      if (!delivery || releaseStarted) {
        return;
      }
      releaseStarted = true;
      for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
        try {
          await flight.releaseOpenIDRefreshFlightDelivery(delivery);
          return;
        } catch (error) {
          if (attempt === RELEASE_ATTEMPTS) {
            logger.warn(`[${context}] Failed to release OpenID response delivery`, {
              error: error instanceof Error ? error.message : error,
            });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_DELAY_MS));
        }
      }
    };

    try {
      await assertReusableSessionGeneration(openidTokens);
      if (openidTokens?.publicationFlightKey && openidTokens?.publicationFlightOwnerId) {
        const claimed = await flight.claimOpenIDRefreshFlightDelivery({
          key: openidTokens.publicationFlightKey,
          ownerId: openidTokens.publicationFlightOwnerId,
          createdAt: openidTokens.publicationFlightCreatedAt,
        });
        if (!claimed.deliveryId) {
          throw new Error('OpenID response delivery claim returned no owner');
        }
        delivery = {
          key: openidTokens.publicationFlightKey,
          ownerId: openidTokens.publicationFlightOwnerId,
          deliveryId: claimed.deliveryId,
        };
      }

      const sendAuthorized: SendAuthorized = async (send) => {
        if (delivery) {
          await flight.assertOpenIDRefreshFlightDeliveryAvailable(delivery);
          if (!listenersArmed && typeof res.once === 'function' && !res.closed) {
            listenersArmed = true;
            res.once('finish', () => void releaseDelivery());
            res.once('close', () => void releaseDelivery());
          }
        } else {
          await assertReusableSessionGeneration(openidTokens);
        }
        const response = send();
        responseSent = true;
        if (delivery && !listenersArmed) {
          await releaseDelivery();
        }
        return response;
      };

      return await operation(sendAuthorized);
    } finally {
      if (delivery && !responseSent) {
        await releaseDelivery();
      }
    }
  };
}
