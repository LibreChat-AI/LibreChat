import { setTimeout as delay } from 'node:timers/promises';
import type { Model } from 'mongoose';
import type {
  IOpenIDRefreshFlight,
  OpenIDRefreshFlightCreateData,
  OpenIDRefreshFlightCompleteData,
  OpenIDRefreshFlightRenewData,
  OpenIDRefreshFlightFailData,
  OpenIDRefreshFlightRevokeData,
  OpenIDRefreshFlightQuery,
  OpenIDRefreshFlightAcquireResult,
  OpenIDRefreshFlightClaimDeliveryData,
  OpenIDRefreshFlightReleaseDeliveryData,
} from '~/types';
import { createIndexesWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

const DELIVERY_RELEASE_POLL_MS = 100;

function hasErrorCode(error: unknown): error is { code: number } {
  return (
    typeof error === 'object' &&
    error != null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'number'
  );
}

function isDuplicateKeyError(error: unknown): boolean {
  return hasErrorCode(error) && error.code === 11000;
}

export function createOpenIDRefreshFlightMethods(mongoose: typeof import('mongoose')): {
  acquireOpenIDRefreshFlight: (
    data: OpenIDRefreshFlightCreateData,
  ) => Promise<OpenIDRefreshFlightAcquireResult>;
  completeOpenIDRefreshFlight: (
    data: OpenIDRefreshFlightCompleteData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  renewOpenIDRefreshFlight: (
    data: OpenIDRefreshFlightRenewData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  failOpenIDRefreshFlight: (
    data: OpenIDRefreshFlightFailData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  revokeOpenIDRefreshFlight: (
    data: OpenIDRefreshFlightRevokeData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  claimOpenIDRefreshFlightDelivery: (
    data: OpenIDRefreshFlightClaimDeliveryData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  releaseOpenIDRefreshFlightDelivery: (
    data: OpenIDRefreshFlightReleaseDeliveryData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  findOpenIDRefreshFlight: (
    query: OpenIDRefreshFlightQuery,
  ) => Promise<IOpenIDRefreshFlight | null>;
} {
  let indexesPromise: Promise<void> | null = null;

  function ensureIndexes(): Promise<void> {
    if (!indexesPromise) {
      const OpenIDRefreshFlight = mongoose.models
        .OpenIDRefreshFlight as Model<IOpenIDRefreshFlight>;
      indexesPromise = createIndexesWithRetry(OpenIDRefreshFlight).catch((error) => {
        indexesPromise = null;
        throw error;
      });
    }
    return indexesPromise;
  }

  async function acquireOpenIDRefreshFlight(
    data: OpenIDRefreshFlightCreateData,
  ): Promise<OpenIDRefreshFlightAcquireResult> {
    const OpenIDRefreshFlight = mongoose.models.OpenIDRefreshFlight as Model<IOpenIDRefreshFlight>;
    const now = new Date();

    await ensureIndexes();

    try {
      const flight = await OpenIDRefreshFlight.create({
        ...data,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
      return { acquired: true, flight };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        logger.debug('[acquireOpenIDRefreshFlight] Error creating flight:', error);
        throw error;
      }
    }

    try {
      const reclaimed = await OpenIDRefreshFlight.findOneAndUpdate(
        {
          key: data.key,
          $or: [
            { status: 'failed' },
            { expiresAt: { $lte: now } },
            { status: 'pending', lockExpiresAt: { $lte: now } },
          ],
        },
        {
          $set: {
            ownerId: data.ownerId,
            status: 'pending',
            createdAt: now,
            lockExpiresAt: data.lockExpiresAt,
            expiresAt: data.expiresAt,
            updatedAt: now,
          },
          $unset: {
            encryptedResult: '',
            errorMessage: '',
            deliveryId: '',
            deliveryExpiresAt: '',
            revocationRequestedAt: '',
          },
        },
        { new: true },
      ).lean<IOpenIDRefreshFlight>();

      if (reclaimed) {
        return { acquired: true, flight: reclaimed };
      }

      const existing = await OpenIDRefreshFlight.findOne({
        key: data.key,
        expiresAt: { $gt: now },
      })
        .read('primary')
        .lean<IOpenIDRefreshFlight>();

      return { acquired: false, flight: existing };
    } catch (error) {
      logger.debug('[acquireOpenIDRefreshFlight] Error acquiring flight:', error);
      throw error;
    }
  }

  async function completeOpenIDRefreshFlight(
    data: OpenIDRefreshFlightCompleteData,
  ): Promise<IOpenIDRefreshFlight | null> {
    try {
      const OpenIDRefreshFlight = mongoose.models
        .OpenIDRefreshFlight as Model<IOpenIDRefreshFlight>;
      return await OpenIDRefreshFlight.findOneAndUpdate(
        {
          key: data.key,
          ownerId: data.ownerId,
          status: 'pending',
        },
        {
          $set: {
            status: 'completed',
            encryptedResult: data.encryptedResult,
            expiresAt: data.expiresAt,
            updatedAt: new Date(),
          },
          $unset: {
            errorMessage: '',
            deliveryId: '',
            deliveryExpiresAt: '',
            revocationRequestedAt: '',
          },
        },
        { new: true },
      ).lean<IOpenIDRefreshFlight>();
    } catch (error) {
      logger.debug('[completeOpenIDRefreshFlight] Error completing flight:', error);
      throw error;
    }
  }

  async function renewOpenIDRefreshFlight(
    data: OpenIDRefreshFlightRenewData,
  ): Promise<IOpenIDRefreshFlight | null> {
    try {
      const OpenIDRefreshFlight = mongoose.models
        .OpenIDRefreshFlight as Model<IOpenIDRefreshFlight>;
      return await OpenIDRefreshFlight.findOneAndUpdate(
        {
          key: data.key,
          ownerId: data.ownerId,
          status: 'pending',
        },
        {
          $set: {
            lockExpiresAt: data.lockExpiresAt,
            expiresAt: data.expiresAt,
            updatedAt: new Date(),
          },
        },
        { new: true },
      ).lean<IOpenIDRefreshFlight>();
    } catch (error) {
      logger.debug('[renewOpenIDRefreshFlight] Error renewing flight:', error);
      throw error;
    }
  }

  async function failOpenIDRefreshFlight(
    data: OpenIDRefreshFlightFailData,
  ): Promise<IOpenIDRefreshFlight | null> {
    try {
      const OpenIDRefreshFlight = mongoose.models
        .OpenIDRefreshFlight as Model<IOpenIDRefreshFlight>;
      return await OpenIDRefreshFlight.findOneAndUpdate(
        {
          key: data.key,
          ownerId: data.ownerId,
          status: 'pending',
        },
        {
          $set: {
            status: 'failed',
            errorMessage: data.errorMessage,
            expiresAt: data.expiresAt,
            updatedAt: new Date(),
          },
          $unset: {
            encryptedResult: '',
            deliveryId: '',
            deliveryExpiresAt: '',
            revocationRequestedAt: '',
          },
        },
        { new: true },
      ).lean<IOpenIDRefreshFlight>();
    } catch (error) {
      logger.debug('[failOpenIDRefreshFlight] Error failing flight:', error);
      throw error;
    }
  }

  async function findOpenIDRefreshFlight(
    query: OpenIDRefreshFlightQuery,
  ): Promise<IOpenIDRefreshFlight | null> {
    try {
      const OpenIDRefreshFlight = mongoose.models
        .OpenIDRefreshFlight as Model<IOpenIDRefreshFlight>;
      return await OpenIDRefreshFlight.findOne({
        key: query.key,
        expiresAt: { $gt: new Date() },
      })
        .read('primary')
        .lean<IOpenIDRefreshFlight>();
    } catch (error) {
      logger.debug('[findOpenIDRefreshFlight] Error finding flight:', error);
      throw error;
    }
  }

  async function claimOpenIDRefreshFlightDelivery(
    data: OpenIDRefreshFlightClaimDeliveryData,
  ): Promise<IOpenIDRefreshFlight | null> {
    try {
      const OpenIDRefreshFlight = mongoose.models
        .OpenIDRefreshFlight as Model<IOpenIDRefreshFlight>;
      try {
        return await OpenIDRefreshFlight.findOneAndUpdate(
          {
            key: data.key,
            ownerId: data.ownerId,
            status: 'completed',
            revocationRequestedAt: { $exists: false },
            $or: [
              { deliveryId: { $exists: false } },
              { deliveryExpiresAt: { $exists: false } },
              { deliveryExpiresAt: { $lte: new Date() } },
            ],
          },
          {
            $set: {
              deliveryId: data.deliveryId,
              deliveryExpiresAt: data.deliveryExpiresAt,
              updatedAt: new Date(),
            },
            $max: { expiresAt: data.deliveryExpiresAt },
            ...(data.createdAt
              ? {
                  $setOnInsert: {
                    createdAt: data.createdAt,
                    lockExpiresAt: data.deliveryExpiresAt,
                  },
                }
              : {}),
          },
          { new: true, upsert: Boolean(data.createdAt) },
        ).lean<IOpenIDRefreshFlight>();
      } catch (error) {
        if (isDuplicateKeyError(error)) return null;
        throw error;
      }
    } catch (error) {
      logger.debug('[claimOpenIDRefreshFlightDelivery] Error claiming delivery:', error);
      throw error;
    }
  }

  async function releaseOpenIDRefreshFlightDelivery(
    data: OpenIDRefreshFlightReleaseDeliveryData,
  ): Promise<IOpenIDRefreshFlight | null> {
    const OpenIDRefreshFlight = mongoose.models.OpenIDRefreshFlight as Model<IOpenIDRefreshFlight>;
    const delivery = {
      key: data.key,
      ownerId: data.ownerId,
      deliveryId: data.deliveryId,
      status: 'completed',
    } as const;
    try {
      const revoked = await OpenIDRefreshFlight.findOneAndUpdate(
        { ...delivery, revocationRequestedAt: { $exists: true } },
        {
          $set: {
            ownerId: 'revoked',
            status: 'revoked',
            errorMessage: 'OpenID refresh was revoked by logout',
            updatedAt: new Date(),
          },
          $unset: {
            deliveryId: '',
            deliveryExpiresAt: '',
            revocationRequestedAt: '',
          },
        },
        { new: true },
      ).lean<IOpenIDRefreshFlight>();
      if (revoked) return revoked;

      const synthetic = await OpenIDRefreshFlight.findOneAndDelete({
        ...delivery,
        encryptedResult: { $exists: false },
        revocationRequestedAt: { $exists: false },
      }).lean<IOpenIDRefreshFlight>();
      if (synthetic) return null;

      const completed = await OpenIDRefreshFlight.findOneAndUpdate(
        {
          ...delivery,
          encryptedResult: { $exists: true },
          revocationRequestedAt: { $exists: false },
        },
        {
          $set: { updatedAt: new Date() },
          $unset: { deliveryId: '', deliveryExpiresAt: '' },
        },
        { new: true },
      ).lean<IOpenIDRefreshFlight>();
      if (completed) return completed;

      return await OpenIDRefreshFlight.findOneAndUpdate(
        { ...delivery, revocationRequestedAt: { $exists: true } },
        {
          $set: {
            ownerId: 'revoked',
            status: 'revoked',
            errorMessage: 'OpenID refresh was revoked by logout',
            updatedAt: new Date(),
          },
          $unset: {
            deliveryId: '',
            deliveryExpiresAt: '',
            revocationRequestedAt: '',
          },
        },
        { new: true },
      ).lean<IOpenIDRefreshFlight>();
    } catch (error) {
      logger.debug('[releaseOpenIDRefreshFlightDelivery] Error releasing delivery:', error);
      throw error;
    }
  }

  async function revokeOpenIDRefreshFlight(
    data: OpenIDRefreshFlightRevokeData,
  ): Promise<IOpenIDRefreshFlight | null> {
    const OpenIDRefreshFlight = mongoose.models.OpenIDRefreshFlight as Model<IOpenIDRefreshFlight>;
    const now = new Date();
    await ensureIndexes();
    try {
      for (;;) {
        const revoked = await OpenIDRefreshFlight.findOneAndUpdate(
          {
            key: data.key,
            $or: [
              { deliveryId: { $exists: false } },
              { deliveryExpiresAt: { $exists: false } },
              { deliveryExpiresAt: { $lte: new Date() } },
            ],
          },
          {
            $set: {
              ownerId: 'revoked',
              status: 'revoked',
              errorMessage: 'OpenID refresh was revoked by logout',
              lockExpiresAt: data.expiresAt,
              expiresAt: data.expiresAt,
              updatedAt: new Date(),
            },
            $unset: {
              deliveryId: '',
              deliveryExpiresAt: '',
              revocationRequestedAt: '',
            },
          },
          { new: true },
        ).lean<IOpenIDRefreshFlight>();
        if (revoked) return revoked;

        const delivering = await OpenIDRefreshFlight.findOneAndUpdate(
          {
            key: data.key,
            status: 'completed',
            deliveryId: { $exists: true },
            deliveryExpiresAt: { $gt: new Date() },
          },
          {
            $set: {
              revocationRequestedAt: new Date(),
              expiresAt: data.expiresAt,
              updatedAt: new Date(),
            },
          },
          { new: true },
        ).lean<IOpenIDRefreshFlight>();
        if (delivering) {
          await delay(DELIVERY_RELEASE_POLL_MS);
          continue;
        }

        try {
          return await OpenIDRefreshFlight.create({
            key: data.key,
            ownerId: 'revoked',
            status: 'revoked',
            errorMessage: 'OpenID refresh was revoked by logout',
            lockExpiresAt: data.expiresAt,
            expiresAt: data.expiresAt,
            createdAt: now,
            updatedAt: now,
          });
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
        }
      }
    } catch (error) {
      logger.debug('[revokeOpenIDRefreshFlight] Error revoking flight:', error);
      throw error;
    }
  }

  return {
    acquireOpenIDRefreshFlight,
    claimOpenIDRefreshFlightDelivery,
    renewOpenIDRefreshFlight,
    completeOpenIDRefreshFlight,
    failOpenIDRefreshFlight,
    revokeOpenIDRefreshFlight,
    releaseOpenIDRefreshFlightDelivery,
    findOpenIDRefreshFlight,
  };
}

export type OpenIDRefreshFlightMethods = ReturnType<typeof createOpenIDRefreshFlightMethods>;
